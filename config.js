// ============================================================
//  BX53 Microscope Booking — configuration
//  Edit this file, then push to GitHub.
// ============================================================

export const CONFIG = {
  // Paste the config object from Firebase console:
  // Project settings → General → Your apps → Web app → "SDK setup and configuration"
  // While apiKey starts with "YOUR", the app runs in DEMO mode (bookings saved only in this browser).
  firebase: {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT",
    storageBucket: "YOUR_PROJECT.appspot.com",
    messagingSenderId: "000000000000",
    appId: "YOUR_APP_ID",
  },

  // Admin email(s) — must ALSO be listed in firestore.rules (isAdmin function)
  adminEmails: ["admin@example.com"],

  labName: "Department of Fisheries Management, BAU",
  instrument: "Olympus BX53 + EP50 camera",
  location: "Lab room —",            // e.g. "Room 214, Fisheries Building"
  contact: "Lab admin",              // shown in the footer

  // Times are minutes after midnight (480 = 8:00 AM, 840 = 2:00 PM, 1200 = 8:00 PM)
  dayStart: 480,
  dayEnd: 1200,
  groups: {
    female: { label: "Female members" },
    male:   { label: "Male members" },
  },

  // Weekday numbers: 0 = Sunday … 5 = Friday, 6 = Saturday
  offDays: [5, 6],          // Friday & Saturday: male members only, full day

  // Who may book which hours.  [start, end] in minutes.
  workdayAccess: {
    female: [480, 840],     // first half (8 AM–2 PM)
    male:   [480, 1200],    // whole day — first half only if the slot is still free
  },
  offDayAccess: {
    female: null,           // no access on off days
    male:   [480, 1200],
  },
  firstHalfEnd: 840,        // where the female-priority half ends (for shading)

  stepMinutes: 15,          // start/end times snap to this
  maxBookingMinutes: 240,   // longest single booking (admin exempt)
  bookingWindowDays: 7,     // today + next 6 days are open for booking
  maxDaysPerPerson: 3,      // one person can hold bookings on at most 3 different days
  closedWeekdays: [],       // fully closed days, e.g. [0] for Sunday
};
