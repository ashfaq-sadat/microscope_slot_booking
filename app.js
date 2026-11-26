import { CONFIG } from "./config.js?v=4";

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
const normUser = (u) => String(u || "").trim().toLowerCase();
const STEP = CONFIG.stepMinutes;
const SPAN = CONFIG.dayEnd - CONFIG.dayStart;

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function friendlyAuthError(e) {
  const c = e?.code || "";
  if (/invalid-credential|wrong-password|user-not-found|invalid-email|unknown-user/.test(c) || e?.message === "unknown-user") return "Wrong username or password.";
  if (/too-many-requests/.test(c)) return "Too many attempts. Wait a few minutes and try again.";
  if (/weak-password/.test(c)) return "Password must be at least 6 characters.";
  if (/network/.test(c)) return "No internet connection.";
  if (/operation-not-allowed/.test(c)) return "Email/Password sign-in is not enabled in Firebase.";
  return e?.message || String(e);
}
const randSuffix = () => Math.random().toString(36).slice(2, 6);
const hiddenEmail = (u) => `${u}.${randSuffix()}@${CONFIG.userDomain}`;

/* ---------------- backends ---------------- */
const DEMO = !CONFIG.firebase || String(CONFIG.firebase.apiKey).startsWith("YOUR");

// Demo backend: everything in this browser's localStorage. Admin password: "demo".
function demoBackend() {
  const K = { b: "bx53-demo-bookings", m: "bx53-demo-members", s: "bx53-demo-session" };
  const load = (k, d) => JSON.parse(localStorage.getItem(k) || d);
  const save = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); fire(); };
  const subs = new Set(); let authCb = () => {};
  const fire = () => subs.forEach((s) => s());
  window.addEventListener("storage", fire);
  const current = () => {
    const s = load(K.s, "null"); if (!s) return null;
    if (s.admin) return { uid: "admin", email: s.email, isAdmin: true, member: null };
    const m = load(K.m, "[]").find((x) => x.uid === s.uid && x.active);
    return m ? { uid: m.uid, email: m.email, isAdmin: false, member: m } : null;
  };
  const mkErr = (code) => Object.assign(new Error(code), { code });
  return {
    onAuth(cb) { authCb = cb; setTimeout(() => cb(current())); },
    subscribe(from, to, cb) {
      const run = () => cb(load(K.b, "[]").filter((b) => b.date >= from && b.date <= to));
      subs.add(run); run(); return () => subs.delete(run);
    },
    async create(b) {
      const a = load(K.b, "[]");
      if (a.some((x) => x.date === b.date && x.start < b.end && b.start < x.end)) throw new Error("conflict");
      a.push({ ...b, id: randSuffix() + randSuffix(), uid: current().uid }); save(K.b, a);
    },
    async remove(b) { save(K.b, load(K.b, "[]").filter((x) => x.id !== b.id)); },
    async login(u, pw) {
      if (u.includes("@")) {
        if (CONFIG.adminEmails.includes(u) && pw === "demo") { localStorage.setItem(K.s, JSON.stringify({ admin: true, email: u })); return authCb(current()); }
        throw mkErr("auth/invalid-credential");
      }
      const m = load(K.m, "[]").find((x) => x.username === normUser(u) && x.active);
      if (!m || m.password !== pw) throw mkErr("auth/invalid-credential");
      localStorage.setItem(K.s, JSON.stringify({ uid: m.uid })); authCb(current());
    },
    async logout() { localStorage.removeItem(K.s); authCb(null); },
    async changePassword(old, nw) {
      const ms = load(K.m, "[]"); const me = ms.find((x) => x.uid === current().uid);
      if (me.password !== old) throw mkErr("auth/wrong-password"); me.password = nw; save(K.m, ms);
    },
    subscribeMembers(cb) { const run = () => cb(load(K.m, "[]").filter((m) => m.active)); subs.add(run); run(); return () => subs.delete(run); },
    async addMember({ username, name, gender, password }) {
      const ms = load(K.m, "[]");
      if (ms.some((m) => m.username === username && m.active)) throw new Error(`Username “${username}” is already taken.`);
      ms.push({ uid: "u" + randSuffix() + randSuffix(), username, name, gender, password, email: hiddenEmail(username), active: true }); save(K.m, ms);
    },
    async resetPassword(m, pw) { const ms = load(K.m, "[]"); ms.find((x) => x.uid === m.uid).password = pw; save(K.m, ms); },
    async removeMember(m) { const ms = load(K.m, "[]"); ms.find((x) => x.uid === m.uid).active = false; save(K.m, ms); },
  };
}

async function firebaseBackend() {
  const V = "10.12.2";
  const { initializeApp, deleteApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const A = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
  const F = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
  const app = initializeApp(CONFIG.firebase);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const lockIds = (b) => { const ids = []; for (let m = b.start; m < b.end; m += STEP) ids.push(`${b.date}_${m}`); return ids; };

  // Create a Firebase Auth account without signing the admin out (uses a throwaway app instance)
  async function createAuthUser(email, password) {
    const tmp = initializeApp(CONFIG.firebase, "creator-" + Date.now());
    try {
      const cred = await A.createUserWithEmailAndPassword(A.getAuth(tmp), email, password);
      await A.signOut(A.getAuth(tmp));
      return cred.user.uid;
    } finally { await deleteApp(tmp); }
  }

  return {
    onAuth(cb) {
      A.onAuthStateChanged(auth, async (u) => {
        if (!u) return cb(null);
        if (u.isAnonymous) { await A.signOut(auth); return; } // leftovers from the old version
        const isAdmin = CONFIG.adminEmails.includes(u.email);
        let member = null;
        try {
          const s = await F.getDoc(F.doc(db, "members", u.uid));
          if (s.exists() && s.data().active) member = { uid: u.uid, ...s.data() };
        } catch (e) { console.warn(e); }
        if (!isAdmin && !member) { await A.signOut(auth); toast("This account has been removed. Ask the lab admin."); return cb(null); }
        cb({ uid: u.uid, email: u.email, isAdmin, member });
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
      // One lock per 15-min step: the rules only allow creating a lock that doesn't exist yet,
      // so two people can never hold the same time even if they press "Confirm" at the same moment.
      for (const id of lockIds(b)) batch.set(F.doc(db, "locks", id), { bookingId: ref.id, uid, date: b.date, m: Number(id.split("_")[1]) });
      try { await batch.commit(); }
      catch (e) { if (e.code === "permission-denied") throw new Error("conflict"); throw e; }
    },
    async remove(b) {
      const batch = F.writeBatch(db);
      batch.delete(F.doc(db, "bookings", b.id));
      for (const id of lockIds(b)) batch.delete(F.doc(db, "locks", id));
      await batch.commit();
    },
    async login(u, pw) {
      let email = u;
      if (!u.includes("@")) {
        const s = await F.getDoc(F.doc(db, "usernames", normUser(u)));
        if (!s.exists()) throw Object.assign(new Error("unknown-user"), { code: "unknown-user" });
        email = s.data().email;
      }
      await A.signInWithEmailAndPassword(auth, email, pw);
    },
    async logout() { await A.signOut(auth); },
    async changePassword(old, nw) {
      const u = auth.currentUser;
      await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, old));
      await A.updatePassword(u, nw);
    },
    subscribeMembers(cb) {
      return F.onSnapshot(F.query(F.collection(db, "members"), F.where("active", "==", true)),
        (snap) => cb(snap.docs.map((d) => ({ uid: d.id, ...d.data() }))),
        (e) => toast("Could not load members: " + e.code));
    },
    async addMember({ username, name, gender, password }) {
      const taken = await F.getDoc(F.doc(db, "usernames", username));
      if (taken.exists()) throw new Error(`Username “${username}” is already taken.`);
      const email = hiddenEmail(username);
      const uid = await createAuthUser(email, password);
      const batch = F.writeBatch(db);
      batch.set(F.doc(db, "members", uid), { username, name, gender, email, active: true, createdAt: F.serverTimestamp() });
      batch.set(F.doc(db, "usernames", username), { email, uid });
      await batch.commit();
    },
    // Without a paid server we can't overwrite someone's password, so a reset gives the member
    // a fresh account under the same username and retires the old one. Their bookings stay theirs.
    async resetPassword(m, password) {
      const email = hiddenEmail(m.username);
      const uid = await createAuthUser(email, password);
      const batch = F.writeBatch(db);
      batch.set(F.doc(db, "members", uid), { username: m.username, name: m.name, gender: m.gender, email, active: true, createdAt: F.serverTimestamp() });
      batch.update(F.doc(db, "members", m.uid), { active: false });
      batch.set(F.doc(db, "usernames", m.username), { email, uid });
      await batch.commit();
    },
    async removeMember(m) {
      const batch = F.writeBatch(db);
      batch.update(F.doc(db, "members", m.uid), { active: false });
      batch.delete(F.doc(db, "usernames", m.username));
      await batch.commit();
    },
  };
}

/* ---------------- state ---------------- */
let backend;
let user = null; // { uid, email, isAdmin, member: {username, name, gender} | null }
let weekStart = new Date(); weekStart.setHours(0, 0, 0, 0);
let bookings = [];
let unsub = null;
const windowCache = new Map(); // every booking from today to the end of the booking window
let unsubWindow = null;

const groupLabel = (key) => CONFIG.groups[key]?.label ?? (key === "admin" ? "Admin" : "—");
const isOffDay = (dateStr) => CONFIG.offDays.includes(parseYmd(dateStr).getDay());
const isClosed = (dateStr) => CONFIG.closedWeekdays.includes(parseYmd(dateStr).getDay());
const todayStr = () => ymd(new Date());
const maxDateStr = () => ymd(addDays(new Date(), CONFIG.bookingWindowDays - 1));
function accessFor(group, dateStr) {
  const w = (isOffDay(dateStr) ? CONFIG.offDayAccess : CONFIG.workdayAccess)[group];
  return w ? { start: w[0], end: w[1] } : null;
}
const isMine = (b) => !!user && (b.uid === user.uid || (user.member && b.username === user.member.username));
const canBook = () => !!user && (user.member || user.isAdmin);

/* ---------------- static UI ---------------- */
$("#subtitle").textContent = `${CONFIG.instrument} · ${CONFIG.labName}`;
$("#footerInfo").textContent = `${CONFIG.location} · Questions: ${CONFIG.contact}`;
$("#demoBanner").hidden = !DEMO;
if (DEMO) $("#demoBanner").innerHTML = 'Demo mode: data is saved only in this browser. Admin sign-in: an email from <code>adminEmails</code> with password <code>demo</code>.';
$("#legend").innerHTML =
  `<span><i class="sw" style="background:var(--sess-a)"></i>${fmt(CONFIG.dayStart)}–${fmt(CONFIG.firstHalfEnd)}: female priority (males may book free slots)</span>` +
  `<span><i class="sw" style="background:var(--sess-b)"></i>${fmt(CONFIG.firstHalfEnd)}–${fmt(CONFIG.dayEnd)} & off days: male members</span>` +
  `<span><i class="sw" style="background:var(--book-mine)"></i>Mine</span><span><i class="sw" style="background:var(--book)"></i>Booked</span>`;
$("#addGender").innerHTML = `<option value="">Group…</option>` + Object.entries(CONFIG.groups).map(([k, g]) => `<option value="${k}">${esc(g.label)}</option>`).join("");

document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

function renderMe() {
  const signedIn = !!user;
  $("#loginBtn").hidden = signedIn;
  $("#logoutBtn").hidden = !signedIn;
  $("#pwBtn").hidden = !signedIn || !user.member; // admin changes their password in Firebase
  $("#membersBtn").hidden = !user?.isAdmin;
  $("#meLabel").hidden = !signedIn;
  if (signedIn) {
    const who = user.member ? `${user.member.name} · ${groupLabel(user.member.gender)}` : "Lab admin";
    $("#meLabel").textContent = who + (user.isAdmin && user.member ? " · Admin" : "");
  }
  $("#newBooking").textContent = signedIn ? "+ Book a slot" : "Sign in to book";
}

/* ---------------- sign in / out ---------------- */
const lf = $("#loginForm");
function openLogin() { lf.reset(); $("#loginError").textContent = ""; $("#loginDlg").showModal(); lf.username.focus(); }
$("#loginBtn").addEventListener("click", openLogin);
lf.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#loginSubmit").disabled = true; $("#loginError").textContent = "";
  try { await backend.login(lf.username.value.trim(), lf.password.value); $("#loginDlg").close(); toast("Signed in"); }
  catch (ex) { $("#loginError").textContent = friendlyAuthError(ex); }
  finally { $("#loginSubmit").disabled = false; }
});
$("#logoutBtn").addEventListener("click", async () => { await backend.logout(); toast("Signed out"); });

const pf = $("#pwForm");
$("#pwBtn").addEventListener("click", () => { pf.reset(); $("#pwError").textContent = ""; $("#pwDlg").showModal(); });
pf.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#pwError"); err.textContent = "";
  if (pf.new1.value !== pf.new2.value) return (err.textContent = "The new passwords don't match.");
  $("#pwSubmit").disabled = true;
  try { await backend.changePassword(pf.old.value, pf.new1.value); $("#pwDlg").close(); toast("Password changed"); }
  catch (ex) { err.textContent = /invalid-credential|wrong-password/.test(ex.code || "") ? "Current password is wrong." : friendlyAuthError(ex); }
  finally { $("#pwSubmit").disabled = false; }
});

/* ---------------- members (admin) ---------------- */
let members = [];
let unsubMembers = null;
const af = $("#addForm");
function genPassword() {
  const words = ["slide", "lens", "focus", "stage", "prism", "cell", "gill", "scale", "fin", "algae"];
  return words[Math.floor(Math.random() * words.length)] + (1000 + Math.floor(Math.random() * 9000));
}
function showCreds(username, password, verb) {
  const text = `BX53 booking: ${location.origin + location.pathname}\nUsername: ${username}\nPassword: ${password}`;
  const box = $("#newCreds");
  box.hidden = false;
  box.innerHTML = `<span>${verb} — username <code>${esc(username)}</code> password <code>${esc(password)}</code></span><button class="ghost" type="button" id="copyCreds">Copy login message</button>`;
  $("#copyCreds").onclick = async () => { try { await navigator.clipboard.writeText(text); toast("Copied. Paste it to the member"); } catch { toast("Couldn't copy"); } };
}
function renderMembers() {
  const rows = [...members].sort((a, b) => a.name.localeCompare(b.name));
  $("#membersBody").innerHTML = rows.length ? rows.map((m) => `<tr>
    <td>${esc(m.name)}</td><td><code>${esc(m.username)}</code></td><td>${esc(groupLabel(m.gender))}</td>
    <td><button class="link" data-reset="${m.uid}">Reset password</button><button class="link del" data-del="${m.uid}">Remove</button></td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">No members yet. Add the first one above.</td></tr>`;
}
$("#membersBtn").addEventListener("click", () => {
  af.reset(); $("#membersError").textContent = ""; $("#newCreds").hidden = true;
  af.password.value = genPassword();
  unsubMembers?.(); unsubMembers = backend.subscribeMembers((list) => { members = list; renderMembers(); });
  $("#membersDlg").showModal();
});
$("#membersDlg").addEventListener("close", () => { unsubMembers?.(); unsubMembers = null; });
$("#genPw").addEventListener("click", () => { af.password.value = genPassword(); });
af.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#membersError"); err.textContent = "";
  const m = { name: af.name.value.trim(), username: normUser(af.username.value), gender: af.gender.value, password: af.password.value };
  if (!/^[a-z0-9_-]{3,20}$/.test(m.username)) return (err.textContent = "Username: 3–20 lowercase letters, numbers, - or _.");
  $("#addSubmit").disabled = true;
  try {
    await backend.addMember(m);
    showCreds(m.username, m.password, `Added ${m.name}`);
    af.reset(); af.password.value = genPassword();
  } catch (ex) { err.textContent = friendlyAuthError(ex); }
  finally { $("#addSubmit").disabled = false; }
});
$("#membersBody").addEventListener("click", async (e) => {
  const err = $("#membersError"); err.textContent = "";
  const resetId = e.target.dataset.reset, delId = e.target.dataset.del;
  const m = members.find((x) => x.uid === (resetId || delId)); if (!m) return;
  try {
    if (resetId) {
      const pw = genPassword();
      e.target.disabled = true;
      await backend.resetPassword(m, pw);
      showCreds(m.username, pw, `New password for ${m.name}`);
    } else if (delId) {
      if (e.target.dataset.confirm !== "1") { e.target.dataset.confirm = "1"; e.target.textContent = "Click again to remove"; return; }
      await backend.removeMember(m);
      toast(`${m.name} removed`);
    }
  } catch (ex) { err.textContent = friendlyAuthError(ex); }
  finally { e.target.disabled = false; }
});

/* ---------------- calendar ---------------- */
function weekDates() { return Array.from({ length: 7 }, (_, i) => ymd(addDays(weekStart, i))); }

function subscribeWeek() {
  unsub?.();
  const d = weekDates();
  $("#rangeLabel").textContent = `${fmtDate(d[0], { day: "numeric", month: "short" })} – ${fmtDate(d[6], { day: "numeric", month: "short", year: "numeric" })}`;
  unsub = backend.subscribe(d[0], d[6], (list) => { bookings = list; render(); });
}
function subscribeWindow() {
  unsubWindow?.();
  unsubWindow = backend.subscribe(todayStr(), maxDateStr(), (list) => {
    windowCache.clear(); list.forEach((b) => windowCache.set(b.id, b)); renderMine();
  });
}

const px = (min) => `calc(${(min - CONFIG.dayStart) / 60} * var(--hour))`;

function render() {
  const dates = weekDates();
  const today = todayStr();
  let html = `<div class="head"></div>`;
  for (const d of dates) {
    const dt = parseYmd(d);
    html += `<div class="head ${d === today ? "today" : ""} ${isClosed(d) ? "closed" : ""}">
      <div class="dow">${dt.toLocaleDateString("en-GB", { weekday: "short" })}</div>
      <div class="dnum">${dt.getDate()}</div></div>`;
  }
  html += `<div class="times">`;
  for (let m = CONFIG.dayStart; m < CONFIG.dayEnd; m += 60) html += `<div>${fmt(m).replace(":00", "")}</div>`;
  html += `</div>`;
  const nm = nowMin();
  for (const d of dates) {
    const tooFar = d > maxDateStr() && !user?.isAdmin;
    html += `<div class="col ${isClosed(d) ? "closed" : ""} ${tooFar ? "locked" : ""}" data-date="${d}" style="height:calc(${SPAN / 60} * var(--hour))">`;
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
      const h = b.end - b.start;
      html += `<button class="bk ${isMine(b) ? "mine" : ""} ${b.type === "maintenance" ? "maint" : ""}" data-id="${b.id}"
        style="top:calc(${px(b.start)} + 1px);height:calc(${h / 60} * var(--hour) - 2px)" title="${esc(b.name)} · ${fmt(b.start)}–${fmt(b.end)}">
        <span class="t">${fmt(b.start)}–${fmt(b.end)}</span>
        <span class="n">${b.type === "maintenance" ? "Maintenance" : esc(b.name)}</span>
        ${h >= 60 ? `<span class="p">${esc(b.purpose)}</span>` : ""}</button>`;
    }
    html += `</div>`;
  }
  $("#calendar").innerHTML = html;
  renderMine();
}

function upcomingMine() {
  const now = todayStr(), nm = nowMin();
  return [...windowCache.values()]
    .filter((b) => isMine(b) && b.type !== "maintenance" && (b.date > now || (b.date === now && b.end > nm)))
    .sort((a, b) => (a.date + pad(a.start)).localeCompare(b.date + pad(b.start)));
}
function renderMine() {
  if (!user) { $("#myList").innerHTML = `<li class="empty">Sign in to see and manage your bookings.</li>`; return; }
  const mine = upcomingMine();
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
$("#myList").addEventListener("click", (e) => { const id = e.target.dataset.mine; if (id) openDetail(windowCache.get(id)); });

$("#prevWeek").onclick = () => { weekStart = addDays(weekStart, -7); subscribeWeek(); };
$("#nextWeek").onclick = () => { weekStart = addDays(weekStart, 7); subscribeWeek(); };
$("#todayBtn").onclick = () => { weekStart = new Date(); weekStart.setHours(0, 0, 0, 0); subscribeWeek(); };
$("#newBooking").onclick = () => openBooking(todayStr(), null);

/* ---------------- booking dialog ---------------- */
const bf = $("#bookForm");
const myGroup = () => user?.member?.gender ?? null;

function windowFor(isMaint) {
  if (isMaint || (user?.isAdmin && !user.member)) return { start: CONFIG.dayStart, end: CONFIG.dayEnd };
  return accessFor(myGroup(), bf.date.value) || { start: 0, end: 0 };
}
let dialogDay = [];
function bookingsFor(date) {
  return [...bookings, ...dialogDay, ...windowCache.values()].filter((b, i, a) => b.date === date && a.findIndex((x) => x.id === b.id) === i);
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
  const maxLen = isMaint || (user?.isAdmin && !user.member) ? SPAN : CONFIG.maxBookingMinutes;
  const nextBk = Math.min(w.end, ...bookingsFor(bf.date.value).filter((b) => b.start > s).map((b) => b.start));
  const ends = [];
  if (s) for (let m = s + STEP; m <= Math.min(w.end, s + maxLen, nextBk); m += STEP) ends.push(m);
  bf.end.innerHTML = ends.map((m) => `<option value="${m}">${fmt(m)} (${(m - s) / 60} h)</option>`).join("");
  bf.end.value = ends.includes(prev) ? prev : (ends.find((m) => m === s + 60) ?? ends[ends.length - 1] ?? "");
}

let dlgUnsub = null;
function openBooking(date, start) {
  if (!user) return openLogin();
  if (!canBook()) return toast("Your account can't book. Ask the lab admin.");
  bf.reset();
  $("#bookError").textContent = "";
  $("#maintWrap").hidden = !user.isAdmin;
  bf.date.min = todayStr(); bf.date.max = user.isAdmin ? "" : maxDateStr();
  if (!user.isAdmin && date > maxDateStr()) date = maxDateStr();
  bf.date.value = date < todayStr() ? todayStr() : date;
  watchDialogDate();
  fillTimes(start);
  $("#bookDlg").showModal();
}
function watchDialogDate() {
  dlgUnsub?.(); dialogDay = [];
  const d = bf.date.value; if (!d) return;
  dlgUnsub = backend.subscribe(d, d, (list) => { dialogDay = list; fillTimes(); });
}
$("#bookDlg").addEventListener("close", () => { dlgUnsub?.(); dlgUnsub = null; });
bf.date.addEventListener("change", () => { watchDialogDate(); fillTimes(); });
bf.start.addEventListener("change", () => fillEnds(windowFor(bf.maintenance.checked), bf.maintenance.checked));
bf.maintenance.addEventListener("change", () => fillTimes());

bf.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#bookError"); err.textContent = "";
  const isMaint = user.isAdmin && bf.maintenance.checked;
  const m = user.member;
  const b = {
    date: bf.date.value, start: Number(bf.start.value), end: Number(bf.end.value),
    name: isMaint ? "Maintenance" : (m ? m.name : "Lab admin"),
    username: isMaint ? "admin" : (m ? m.username : "admin"),
    gender: isMaint || !m ? "admin" : m.gender,
    purpose: bf.purpose.value.trim(),
    type: isMaint ? "maintenance" : "booking",
  };
  if (!b.start || !b.end || b.end <= b.start) return (err.textContent = "Pick a valid start and end time.");
  if (bookingsFor(b.date).some((x) => x.start < b.end && b.start < x.end)) return (err.textContent = "That overlaps an existing booking.");
  if (m && !isMaint) {
    if (isClosed(b.date)) return (err.textContent = "The lab is closed on this day.");
    if (!user.isAdmin && b.date > maxDateStr()) return (err.textContent = `Booking is open only for the next ${CONFIG.bookingWindowDays} days.`);
    const w = accessFor(m.gender, b.date);
    if (!w || b.start < w.start || b.end > w.end) return (err.textContent = "That time isn't open to your group on this day.");
    const myDays = new Set(upcomingMine().map((x) => x.date));
    if (!user.isAdmin && !myDays.has(b.date) && myDays.size >= CONFIG.maxDaysPerPerson)
      return (err.textContent = `You already have bookings on ${CONFIG.maxDaysPerPerson} days (the limit). Cancel one to book another day.`);
  }
  $("#bookSubmit").disabled = true;
  try {
    await backend.create(b);
    $("#bookDlg").close();
    toast(`Booked ${fmtDate(b.date)}, ${fmt(b.start)}–${fmt(b.end)}`);
    const d = parseYmd(b.date);
    if (d < weekStart || d > addDays(weekStart, 6)) { weekStart = d; subscribeWeek(); }
  } catch (ex) {
    err.textContent = ex.message === "conflict"
      ? "Someone just booked part of that time (or it isn't allowed for your group). Pick another slot."
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
  if (b.type !== "maintenance") rows.push(["Group", groupLabel(b.gender)]);
  $("#dList").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
  $("#dCancel").hidden = !(isMine(b) || user?.isAdmin);
  $("#detailDlg").showModal();
}
$("#dCancel").addEventListener("click", async () => {
  if (!current) return;
  $("#dCancel").disabled = true;
  try { await backend.remove(current); $("#detailDlg").close(); toast("Booking cancelled"); }
  catch (e) { $("#dError").textContent = "Could not cancel: " + e.message; }
  finally { $("#dCancel").disabled = false; }
});

/* ---------------- boot ---------------- */
(async function boot() {
  try { backend = DEMO ? demoBackend() : await firebaseBackend(); }
  catch (e) { toast("Failed to start: " + e.message); console.error(e); return; }
  let first = true;
  backend.onAuth((u) => {
    user = u; renderMe();
    if (first) { first = false; subscribeWeek(); subscribeWindow(); }
    else render();
  });
  setInterval(render, 60_000);
})();
