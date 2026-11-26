import { CONFIG } from "./config.js?v=3";

/* ---------------- helpers ---------------- */
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmt = (m) => { const h = Math.floor(m / 60), mm = m % 60; const ap = h >= 12 ? "PM" : "AM"; return `${((h + 11) % 12) + 1}:${pad(mm)} ${ap}`; };
const fmtDate = (s, opts = { weekday: "short", day: "numeric", month: "short" }) => parseYmd(s).toLocaleDateString("en-GB", opts);
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STEP = CONFIG.stepMinutes;
const SPAN = CONFIG.dayEnd - CONFIG.dayStart;

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------------- backends ---------------- */
const DEMO = !CONFIG.firebase || String(CONFIG.firebase.apiKey).startsWith("YOUR");

function demoBackend() {
  const KEY = "bx53-demo-bookings";
  let uid = localStorage.getItem("bx53-demo-uid");
  if (!uid) { uid = "demo-" + Math.random().toString(36).slice(2); localStorage.setItem("bx53-demo-uid", uid); }
  let user = { uid, isAdmin: false, email: null };
  const subs = new Set(); let authCb = null;
  const all = () => JSON.parse(localStorage.getItem(KEY) || "[]");
  const save = (a) => { localStorage.setItem(KEY, JSON.stringify(a)); subs.forEach((s) => s.run()); };
  window.addEventListener("storage", (e) => e.key === KEY && subs.forEach((s) => s.run()));
  return {
    onAuth(cb) { authCb = cb; setTimeout(() => cb(user)); },
    subscribe(from, to, cb) {
      const s = { run: () => cb(all().filter((b) => b.date >= from && b.date <= to)) };
      subs.add(s); s.run(); return () => subs.delete(s);
    },
    async create(b) {
      const a = all();
      if (a.some((x) => x.date === b.date && x.start < b.end && b.start < x.end)) throw new Error("conflict");
      a.push({ ...b, id: Math.random().toString(36).slice(2), uid: user.uid }); save(a);
    },
    async remove(b) { save(all().filter((x) => x.id !== b.id)); },
    async adminSignIn(email, pw) {
      if (!CONFIG.adminEmails.includes(email) || pw !== "demo") throw new Error("In demo mode use an admin email from config.js and password: demo");
      user = { ...user, isAdmin: true, email }; authCb(user);
    },
    async adminSignOut() { user = { ...user, isAdmin: false, email: null }; authCb(user); },
  };
}

async function firebaseBackend() {
  const V = "10.12.2";
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const A = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
  const F = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
  const app = initializeApp(CONFIG.firebase);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const lockIds = (b) => { const ids = []; for (let m = b.start; m < b.end; m += STEP) ids.push(`${b.date}_${m}`); return ids; };

  return {
    onAuth(cb) {
      A.onAuthStateChanged(auth, (u) => {
        if (!u) { A.signInAnonymously(auth).catch((e) => toast("Sign-in failed: " + e.message)); return; }
        cb({ uid: u.uid, email: u.email, isAdmin: !u.isAnonymous && CONFIG.adminEmails.includes(u.email) });
      });
    },
    subscribe(from, to, cb) {
      const q = F.query(F.collection(db, "bookings"), F.where("date", ">=", from), F.where("date", "<=", to));
      return F.onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (e) => toast("Could not load bookings: " + e.code));
    },
    async create(b) {
      const ref = F.doc(F.collection(db, "bookings"));
      const uid = auth.currentUser.uid;
      const batch = F.writeBatch(db);
      batch.set(ref, { ...b, uid, createdAt: F.serverTimestamp() });
      // One lock doc per time step: the rules only allow creating a lock that doesn't exist yet,
      // so two people can never hold the same slot even if they click at the same moment.
      for (const id of lockIds(b)) {
        const m = Number(id.split("_")[1]);
        batch.set(F.doc(db, "locks", id), { bookingId: ref.id, uid, date: b.date, m });
      }
      try { await batch.commit(); }
      catch (e) { if (e.code === "permission-denied") throw new Error("conflict"); throw e; }
    },
    async remove(b) {
      const batch = F.writeBatch(db);
      batch.delete(F.doc(db, "bookings", b.id));
      for (const id of lockIds(b)) batch.delete(F.doc(db, "locks", id));
      await batch.commit();
    },
    async adminSignIn(email, pw) { await A.signInWithEmailAndPassword(auth, email, pw); },
    async adminSignOut() { await A.signOut(auth); },
  };
}

/* ---------------- state ---------------- */
let backend;
let user = null;
let profile = JSON.parse(localStorage.getItem("bx53-profile") || "null");
let weekStart = new Date(); weekStart.setHours(0, 0, 0, 0);
let bookings = [];
let unsub = null;
const mineCache = new Map(); // id -> booking (for "My upcoming" across weeks)
let unsubMine = null;

const sessionOf = (key) => (CONFIG.groups[key] ? { key, ...CONFIG.groups[key] } : null);
const isOffDay = (dateStr) => CONFIG.offDays.includes(parseYmd(dateStr).getDay());
// Allowed [start,end] window for a group on a date, or null if they can't book that day
function accessFor(group, dateStr) {
  const w = (isOffDay(dateStr) ? CONFIG.offDayAccess : CONFIG.workdayAccess)[group];
  return w ? { start: w[0], end: w[1] } : null;
}
const isClosed = (dateStr) => CONFIG.closedWeekdays.includes(parseYmd(dateStr).getDay());
const todayStr = () => ymd(new Date());
const maxDateStr = () => ymd(addDays(new Date(), CONFIG.bookingWindowDays - 1));

/* ---------------- static UI ---------------- */
$("#subtitle").textContent = `${CONFIG.instrument} · ${CONFIG.labName}`;
$("#footerInfo").textContent = `${CONFIG.location} · Questions: ${CONFIG.contact}`;
$("#demoBanner").hidden = !DEMO;
$("#legend").innerHTML =
  `<span><i class="sw" style="background:var(--sess-a)"></i>${fmt(CONFIG.dayStart)}–${fmt(CONFIG.firstHalfEnd)}: female priority (males may book free slots)</span>` +
  `<span><i class="sw" style="background:var(--sess-b)"></i>${fmt(CONFIG.firstHalfEnd)}–${fmt(CONFIG.dayEnd)} & off days: male members</span>` +
  `<span><i class="sw" style="background:var(--book-mine)"></i>Mine</span><span><i class="sw" style="background:var(--book)"></i>Booked</span>`;
const offNames = CONFIG.offDays.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(" & ");
$("#genderOpts").innerHTML = Object.keys(CONFIG.groups).map((k) => {
  const w = CONFIG.workdayAccess[k], o = CONFIG.offDayAccess[k];
  const desc = `${w ? fmt(w[0]) + "–" + fmt(w[1]) : "—"}${offNames ? (o ? ", incl. " + offNames : ", not " + offNames) : ""}`;
  return `<label><input type="radio" name="gender" value="${k}" required /> ${esc(CONFIG.groups[k].label)} <small>${desc}</small></label>`;
}).join("");

document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

function renderMe() {
  $("#meLabel").textContent = profile ? `${profile.name} · ${sessionOf(profile.gender)?.label ?? ""}` + (user?.isAdmin ? " · Admin" : "") : "Not set";
  $("#adminBtn").textContent = user?.isAdmin ? "Admin sign out" : "Admin";
}

/* ---------------- profile ---------------- */
function openProfile() {
  const f = $("#profileForm");
  if (profile) { f.name.value = profile.name; f.contact.value = profile.contact || ""; const r = f.querySelector(`input[value="${profile.gender}"]`); if (r) r.checked = true; }
  $("#profileDlg").showModal();
}
$("#profileForm").addEventListener("submit", (e) => {
  const f = e.target;
  profile = { name: f.name.value.trim(), gender: f.gender.value, contact: f.contact.value.trim() };
  localStorage.setItem("bx53-profile", JSON.stringify(profile));
  renderMe(); render();
});
$("#profileDlg").addEventListener("cancel", (e) => { if (!profile) e.preventDefault(); });
$("#changeMe").addEventListener("click", openProfile);

/* ---------------- calendar ---------------- */
function weekDates() { return Array.from({ length: 7 }, (_, i) => ymd(addDays(weekStart, i))); }

function subscribeWeek() {
  unsub?.();
  const d = weekDates();
  $("#rangeLabel").textContent = `${fmtDate(d[0], { day: "numeric", month: "short" })} – ${fmtDate(d[6], { day: "numeric", month: "short", year: "numeric" })}`;
  unsub = backend.subscribe(d[0], d[6], (list) => { bookings = list; render(); });
}

function subscribeMine() {
  unsubMine?.();
  unsubMine = backend.subscribe(todayStr(), maxDateStr(), (list) => {
    mineCache.clear(); list.forEach((b) => mineCache.set(b.id, b)); renderMine();
  });
}

const px = (min) => `calc(${(min - CONFIG.dayStart) / 60} * var(--hour))`;

function render() {
  const cal = $("#calendar");
  const dates = weekDates();
  const today = todayStr();
  let html = `<div class="head"></div>`;
  for (const d of dates) {
    const dt = parseYmd(d);
    html += `<div class="head ${d === today ? "today" : ""} ${isClosed(d) ? "closed" : ""}">
      <div class="dow">${dt.toLocaleDateString("en-GB", { weekday: "short" })}</div>
      <div class="dnum">${dt.getDate()}</div></div>`;
  }
  // time labels
  html += `<div class="times">`;
  for (let m = CONFIG.dayStart; m < CONFIG.dayEnd; m += 60) html += `<div>${fmt(m).replace(":00", "")}</div>`;
  html += `</div>`;
  const nm = nowMin();
  for (const d of dates) {
    const closed = isClosed(d);
    const tooFar = d > maxDateStr();
    html += `<div class="col ${closed ? "closed" : ""} ${tooFar ? "locked" : ""}" data-date="${d}" style="height:calc(${SPAN / 60} * var(--hour))">`;
    const bands = isOffDay(d)
      ? [{ start: CONFIG.dayStart, end: CONFIG.dayEnd, c: "b", tag: "Off day · male only" }]
      : [{ start: CONFIG.dayStart, end: CONFIG.firstHalfEnd, c: "a", tag: "Female priority" },
         { start: CONFIG.firstHalfEnd, end: CONFIG.dayEnd, c: "b", tag: "Male" }];
    for (const s of bands) {
      html += `<div class="band" style="top:${px(s.start)};height:calc(${(s.end - s.start) / 60} * var(--hour));background:var(--sess-${s.c})">
        <span class="tag" style="color:var(--sess-${s.c}-ink)">${s.tag}</span></div>`;
    }
    for (let m = CONFIG.dayStart + 30; m < CONFIG.dayEnd; m += 30) html += `<div class="hline ${m % 60 ? "half" : ""}" style="top:${px(m)}"></div>`;
    if (d < today) html += `<div class="past" style="bottom:0"></div>`;
    else if (d === today && nm > CONFIG.dayStart) {
      html += `<div class="past" style="height:${px(Math.min(nm, CONFIG.dayEnd))}"></div>`;
      if (nm < CONFIG.dayEnd) html += `<div class="now" style="top:${px(nm)}"></div>`;
    }
    for (const b of bookings.filter((x) => x.date === d).sort((a, z) => a.start - z.start)) {
      const mine = b.uid === user?.uid;
      const h = b.end - b.start;
      html += `<button class="bk ${mine ? "mine" : ""} ${b.type === "maintenance" ? "maint" : ""}" data-id="${b.id}"
        style="top:calc(${px(b.start)} + 1px);height:calc(${h / 60} * var(--hour) - 2px)" title="${esc(b.name)} · ${fmt(b.start)}–${fmt(b.end)}">
        <span class="t">${fmt(b.start)}–${fmt(b.end)}</span>
        <span class="n">${b.type === "maintenance" ? "Maintenance" : esc(b.name)}</span>
        ${h >= 60 ? `<span class="p">${esc(b.purpose)}</span>` : ""}</button>`;
    }
    html += `</div>`;
  }
  cal.innerHTML = html;
  renderMine();
}

function renderMine() {
  const now = todayStr(), nm = nowMin();
  const mine = [...mineCache.values()]
    .filter((b) => b.uid === user?.uid && (b.date > now || (b.date === now && b.end > nm)))
    .sort((a, b) => (a.date + pad(a.start)).localeCompare(b.date + pad(b.start)));
  $("#myList").innerHTML = mine.length
    ? mine.map((b) => `<li><div><div class="when">${fmtDate(b.date)} · ${fmt(b.start)}–${fmt(b.end)}</div><div class="what">${esc(b.purpose)}</div></div>
        <button class="ghost" data-mine="${b.id}">Details</button></li>`).join("")
    : `<li class="empty">No upcoming bookings.</li>`;
}

$("#calendar").addEventListener("click", (e) => {
  const bk = e.target.closest(".bk");
  if (bk) return openDetail(bookings.find((b) => b.id === bk.dataset.id));
  const col = e.target.closest(".col");
  if (!col || col.classList.contains("closed") || col.classList.contains("locked")) return;
  const rect = col.getBoundingClientRect();
  const min = CONFIG.dayStart + Math.floor(((e.clientY - rect.top) / rect.height) * SPAN / STEP) * STEP;
  openBooking(col.dataset.date, min);
});
$("#myList").addEventListener("click", (e) => {
  const id = e.target.dataset.mine; if (id) openDetail(mineCache.get(id));
});

$("#prevWeek").onclick = () => { weekStart = addDays(weekStart, -7); subscribeWeek(); };
$("#nextWeek").onclick = () => { weekStart = addDays(weekStart, 7); subscribeWeek(); };
$("#todayBtn").onclick = () => { weekStart = new Date(); weekStart.setHours(0, 0, 0, 0); subscribeWeek(); };
$("#newBooking").onclick = () => openBooking(todayStr(), null);

/* ---------------- booking dialog ---------------- */
const bf = $("#bookForm");

function windowFor(isMaint) {
  if (isMaint) return { start: CONFIG.dayStart, end: CONFIG.dayEnd };
  return accessFor(profile?.gender, bf.date.value) || { start: 0, end: 0 };
}

function fillTimes(prefStart) {
  const isMaint = bf.maintenance.checked;
  const w = windowFor(isMaint);
  const d = bf.date.value;
  const minStart = d === todayStr() ? Math.max(w.start, Math.ceil(nowMin() / STEP) * STEP) : w.start;
  const keepStart = prefStart ?? Number(bf.start.value);
  const taken = bookingsFor(d);
  const starts = [];
  for (let m = minStart; m < w.end; m += STEP) if (!taken.some((b) => b.start <= m && m < b.end)) starts.push(m);
  bf.start.innerHTML = starts.map((m) => `<option value="${m}">${fmt(m)}</option>`).join("") || `<option value="">Not available</option>`;
  if (starts.includes(keepStart)) bf.start.value = keepStart;
  else if (keepStart && starts.length) bf.start.value = starts.find((m) => m >= keepStart) ?? starts[0];
  fillEnds(w, isMaint);
  $("#bookHint").textContent = isMaint ? "Blocks the instrument for everyone."
    : !w.end ? `${fmtDate(d)} is an off day: open to male members only.`
    : `You can book ${fmt(w.start)}–${fmt(w.end)} on this day · max ${CONFIG.maxBookingMinutes / 60} h per booking · up to ${CONFIG.maxDaysPerPerson} days in the next ${CONFIG.bookingWindowDays}`;
}

function fillEnds(w, isMaint) {
  const s = Number(bf.start.value);
  const prev = Number(bf.end.value);
  const maxLen = isMaint ? SPAN : CONFIG.maxBookingMinutes;
  // stop at the next booking so overlaps can't be picked
  const nextBk = Math.min(w.end, ...bookingsFor(bf.date.value).filter((b) => b.start > s).map((b) => b.start));
  const ends = [];
  if (s) for (let m = s + STEP; m <= Math.min(w.end, s + maxLen, nextBk); m += STEP) ends.push(m);
  bf.end.innerHTML = ends.map((m) => `<option value="${m}">${fmt(m)} (${(m - s) / 60} h)</option>`).join("");
  bf.end.value = ends.includes(prev) ? prev : (ends.find((m) => m === s + 60) ?? ends[ends.length - 1] ?? "");
}

let weekForDialog = [];
function bookingsFor(date) {
  return [...bookings, ...weekForDialog, ...mineCache.values()].filter((b, i, a) => b.date === date && a.findIndex((x) => x.id === b.id) === i);
}

let dlgUnsub = null;
function openBooking(date, start) {
  if (!profile) return openProfile();
  bf.reset();
  $("#bookError").textContent = "";
  $("#maintWrap").hidden = !user?.isAdmin;
  bf.date.min = todayStr(); bf.date.max = user?.isAdmin ? "" : maxDateStr();
  if (!user?.isAdmin && date > maxDateStr()) date = maxDateStr();
  bf.date.value = date < todayStr() ? todayStr() : date;
  watchDialogDate();
  fillTimes(start);
  $("#bookDlg").showModal();
}
function watchDialogDate() {
  dlgUnsub?.(); weekForDialog = [];
  const d = bf.date.value; if (!d) return;
  dlgUnsub = backend.subscribe(d, d, (list) => { weekForDialog = list; fillTimes(); });
}
$("#bookDlg").addEventListener("close", () => { dlgUnsub?.(); dlgUnsub = null; });
bf.date.addEventListener("change", () => { watchDialogDate(); fillTimes(); });
bf.start.addEventListener("change", () => fillEnds(windowFor(bf.maintenance.checked), bf.maintenance.checked));
bf.maintenance.addEventListener("change", () => fillTimes());

bf.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#bookError"); err.textContent = "";
  const isMaint = user?.isAdmin && bf.maintenance.checked;
  const b = {
    date: bf.date.value, start: Number(bf.start.value), end: Number(bf.end.value),
    name: isMaint ? "Maintenance" : profile.name,
    gender: isMaint ? "admin" : profile.gender,
    contact: profile.contact || "",
    purpose: bf.purpose.value.trim(),
    type: isMaint ? "maintenance" : "booking",
  };
  if (!b.start || !b.end || b.end <= b.start) return (err.textContent = "Pick a valid start and end time.");
  if (isClosed(b.date) && !isMaint) return (err.textContent = "The lab is closed on this day.");
  if (!isMaint && b.date > maxDateStr()) return (err.textContent = `Booking is open only for the next ${CONFIG.bookingWindowDays} days.`);
  if (!isMaint) {
    const w = accessFor(profile.gender, b.date);
    if (!w || b.start < w.start || b.end > w.end) return (err.textContent = "That time isn't open to your group on this day.");
    const me = profile.name.trim().toLowerCase();
    const myDays = new Set([...mineCache.values()]
      .filter((x) => x.type !== "maintenance" && (x.uid === user?.uid || String(x.name).trim().toLowerCase() === me))
      .filter((x) => x.date > todayStr() || (x.date === todayStr() && x.end > nowMin()))
      .map((x) => x.date));
    if (!myDays.has(b.date) && myDays.size >= CONFIG.maxDaysPerPerson)
      return (err.textContent = `You already have bookings on ${CONFIG.maxDaysPerPerson} days (limit). Cancel one to book another day.`);
  }
  if (bookingsFor(b.date).some((x) => x.start < b.end && b.start < x.end)) return (err.textContent = "That overlaps an existing booking.");
  $("#bookSubmit").disabled = true;
  try {
    await backend.create(b);
    $("#bookDlg").close();
    toast(`Booked ${fmtDate(b.date)}, ${fmt(b.start)}–${fmt(b.end)}`);
    const d = parseYmd(b.date);
    if (d < weekStart || d > addDays(weekStart, 6)) { weekStart = d; subscribeWeek(); }
  } catch (ex) {
    err.textContent = ex.message === "conflict"
      ? "Someone just booked part of that time (or it's outside your allowed session). Pick another slot."
      : "Booking failed: " + ex.message;
  } finally { $("#bookSubmit").disabled = false; }
});

/* ---------------- detail dialog ---------------- */
let current = null;
function openDetail(b) {
  if (!b) return;
  current = b;
  $("#dError").textContent = "";
  $("#dTitle").textContent = b.type === "maintenance" ? "Maintenance block" : b.name;
  const rows = [
    ["Date", fmtDate(b.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })],
    ["Time", `${fmt(b.start)} – ${fmt(b.end)} (${(b.end - b.start) / 60} h)`],
    ["Purpose", b.purpose],
  ];
  if (b.type !== "maintenance") rows.push(["Group", sessionOf(b.gender)?.label ?? "—"]);
  if (b.contact) rows.push(["Contact", b.contact]);
  $("#dList").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
  $("#dCancel").hidden = !(b.uid === user?.uid || user?.isAdmin);
  $("#detailDlg").showModal();
}
$("#dCancel").addEventListener("click", async () => {
  if (!current) return;
  $("#dCancel").disabled = true;
  try { await backend.remove(current); $("#detailDlg").close(); toast("Booking cancelled"); }
  catch (e) { $("#dError").textContent = "Could not cancel: " + e.message; }
  finally { $("#dCancel").disabled = false; }
});

/* ---------------- admin ---------------- */
$("#adminBtn").addEventListener("click", async () => {
  if (user?.isAdmin) { await backend.adminSignOut(); toast("Signed out of admin"); return; }
  $("#adminError").textContent = "";
  $("#adminHint").textContent = DEMO
    ? "Demo mode: use an email from config.js adminEmails and password “demo”."
    : "Admins can cancel any booking and block maintenance time.";
  $("#adminDlg").showModal();
});
$("#adminForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try { await backend.adminSignIn(f.email.value.trim(), f.password.value); $("#adminDlg").close(); toast("Signed in as admin"); }
  catch (ex) { $("#adminError").textContent = ex.message; }
});

/* ---------------- boot ---------------- */
(async function boot() {
  try { backend = DEMO ? demoBackend() : await firebaseBackend(); }
  catch (e) { toast("Failed to start: " + e.message); console.error(e); return; }
  let first = true;
  backend.onAuth((u) => {
    user = u; renderMe();
    if (first) { first = false; subscribeWeek(); subscribeMine(); if (!profile) openProfile(); }
    else render();
  });
  setInterval(render, 60_000); // move the "now" line
})();
