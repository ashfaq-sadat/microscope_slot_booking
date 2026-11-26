# BX53 Microscope Booking

A shared booking calendar for the lab's Olympus BX53 + EP50 camera. Lab members can see every booking and book any free time. It runs on GitHub Pages (free hosting), and Firebase Firestore (free tier) stores the bookings.

**Rules built in**
- Hours: 8:00 AM–8:00 PM
- Workdays (Sun–Thu): 8:00 AM–2:00 PM is female priority, but male members can also book any slot there that is still free. 2:00–8:00 PM is for male members only
- Off days (Fri & Sat): male members only, all day
- Bookings open for 7 days (today plus the next 6)
- Each person can hold bookings on at most 3 different days, and can have several bookings on the same day
- Any start and end time in 15-minute steps, up to 4 h per booking
- Two people can't book overlapping times; the database rejects the second booking
- Only the person who made a booking (from the same browser) or the admin can cancel it
- The admin can block time for maintenance, and maintenance blocks ignore all limits

All of these can be changed in `config.js`. If you change the times or limits, update `firestore.rules` too.

---

## Setup (about 15 minutes)

### 1. Create the Firebase project
1. Go to https://console.firebase.google.com and click **Add project** (Google Analytics is not needed).
2. **Build → Firestore Database → Create database**. Pick a location close to Bangladesh (for example `asia-south1`, Mumbai) and start in **production mode**.
3. **Build → Authentication → Get started**, then enable:
   - **Anonymous** (lab members use this, with no login needed)
   - **Email/Password**. Then open the **Users** tab → **Add user** and create the admin account (your email and a password).
4. **Project settings (gear) → General → Your apps → Web (`</>`)**. Register an app (no hosting needed) and copy the `firebaseConfig` object.

### 2. Configure
- In `config.js`, paste the values into `firebase: {...}` and put your admin email in `adminEmails`. Also fill in `location` and `contact`.
- In `firestore.rules`, replace `admin@example.com` with the same admin email. Then in Firebase console → **Firestore → Rules**, paste the whole file and click **Publish**.

### 3. Put it on GitHub Pages
1. Create a new **public** repo on GitHub, e.g. `bx53-booking`.
2. Upload `index.html`, `app.js`, `config.js` and `style.css`. `firestore.rules` and `README.md` are optional.
3. Repo → **Settings → Pages → Source: Deploy from branch → `main` / root → Save**.
4. After a minute the site is live at `https://<your-username>.github.io/bx53-booking/`.

### 4. Allow your site domain in Firebase
Firebase console → **Authentication → Settings → Authorized domains → Add domain** → `<your-username>.github.io`.

Share the link with the lab. That's it.

---

## Notes
- The Firebase web config being visible in a public repo is normal and safe: access is controlled by `firestore.rules`, not by hiding the key.
- Sign-in is anonymous and tied to the browser. If a member clears their browser data or books from another device, they can't cancel the old booking, and the admin will need to cancel it.
- Members choose their own session group. The app enforces each group's time window, but it can't verify who someone is. It runs on trust, like a paper logbook.
- Before you add the Firebase config, the app runs in **demo mode**, where bookings stay in your browser only. This is useful for trying it out. The demo admin password is `demo`.
- To change the off days, edit `offDays` in `config.js` **and** `isOffDay` in `firestore.rules`. Note that the rules count days as 1 = Mon … 7 = Sun, while `config.js` uses 0 = Sun … 6 = Sat. Friday (5) and Saturday (6) are the same number in both.
- The 3-days-per-person limit is checked in the app by browser and name. Someone could get around it by using another device and a different name.
- Free-tier limits (50k reads/day and 20k writes/day) are far more than a lab needs.
