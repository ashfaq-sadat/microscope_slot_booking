# BX53 Microscope Booking

A shared booking calendar for the lab's Olympus BX53 + EP50 camera. Lab members can see every booking and book any free time. It runs on GitHub Pages (free hosting), and Firebase Firestore (free tier) stores the bookings.

**How access works**
- Anyone with the link can **see** the schedule.
- To **book or cancel**, members sign in with the username and password the admin gave them. They can then use any phone or computer.
- Each member's name and group (female/male) is set by the admin, and the database checks every booking against it.
- Members can change their own password (**Password** link at the top).

**Rules built in**
- Hours: 8:00 AM–8:00 PM
- Workdays (Sun–Thu): 8:00 AM–2:00 PM is female priority, but male members can also book any slot there that is still free. 2:00–8:00 PM is for male members only
- Off days (Fri & Sat): male members only, all day
- Bookings open for 7 days (today plus the next 6)
- Each person can hold bookings on at most 3 different days
- Any start and end time in 15-minute steps, up to 4 h per booking
- No overlapping bookings (enforced by the database)
- The admin can cancel anything and block time for maintenance

## Admin: managing members
1. Click **Sign in** and enter your admin **email** and password.
2. Click **Members**. Fill in full name, a short username (e.g. `rina`), the group, and a password (or press **Generate**), then press **Add member**.
3. Press **Copy login message** and paste it to the member on WhatsApp or Messenger.
4. **Reset password** gives the member a new generated password. Their bookings are kept.
5. **Remove** blocks the account from signing in and booking.

Behind the scenes each username gets a hidden login email (e.g. `rina.x7k2@bx53.lab`). Members never see or type it.

## One-time Firebase setup for accounts
1. **Firestore Database → Rules**: paste the whole `firestore.rules` file and click **Publish**.
2. **Authentication → Sign-in method**: keep **Email/Password** enabled. **Anonymous** is no longer used, so you can disable it.
3. **Authentication → Users**: make sure your admin email exists there.

---

## Setup (about 15 minutes)

### 1. Create the Firebase project
1. Go to https://console.firebase.google.com and click **Add project** (Google Analytics is not needed).
2. **Build → Firestore Database → Create database**. Pick a location close to Bangladesh (for example `asia-south1`, Mumbai) and start in **production mode**.
3. **Build → Authentication → Get started**, then enable:
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
- Before you add the Firebase config, the app runs in **demo mode**, where bookings stay in your browser only. This is useful for trying it out. Sign in with an admin email and the password `demo`.
- To change the off days, edit `offDays` in `config.js` **and** `isOffDay` in `firestore.rules`. Note that the rules count days as 1 = Mon … 7 = Sun, while `config.js` uses 0 = Sun … 6 = Sat. Friday (5) and Saturday (6) are the same number in both.
- The 3-days-per-person limit is checked in the app by username (not by the database).
- Free-tier limits (50k reads/day and 20k writes/day) are far more than a lab needs.
