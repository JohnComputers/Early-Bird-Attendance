# ATTENDANCE.SYS

Face-recognition attendance tracking. Upload a photo of who's in the room, it tells you who's there. New faces prompt you for a name; recognition gets better every time. All data lives in your private Firestore project.

---

## How it works

1. **Upload a photo** of the people present.
2. The system detects every face and tries to match each one against your roster.
3. **Unknowns prompt for identification** — pick from existing people or type a new name.
4. **Save the session.** It's logged with the date, an optional label, the photo, and who was there.
5. **Reports** show every session ever taken; export as JSON or CSV.

---

## Setting up Firebase (one-time, ~5 minutes)

1. Create a free Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable Authentication → Google sign-in
3. Enable Firestore (production mode) and paste the rules from [`firestore.rules`](firestore.rules) into the Firestore Rules tab
4. Project Settings → Your apps → `</>` web → register an app → copy the config object into `firebase-config.js`
5. Authentication → Settings → Authorized domains → add `<your-username>.github.io`

The full step-by-step is in the previous version's README; once it's set up the app just works.

**No Firebase Storage needed.** Photos are downscaled and embedded directly in Firestore documents to stay on the free tier.

---

## Deploy to GitHub Pages

Push these files to a repo root:

```
index.html
style.css
firebase-config.js   ← your real config goes here
auth.js
db.js
ml.js
app.js
firestore.rules
README.md
```

Settings → Pages → Deploy from branch → main / root. Visit `https://<username>.github.io/<repo>/`.

---

## Tuning recognition

Open `ml.js`:

- **`MATCH_THRESHOLD = 0.55`** — lower = stricter (fewer false positives, more false negatives). face-api.js default is 0.6. If known people are coming up as "NEW?", raise to 0.6 or 0.65. If different people are getting matched as the same person, drop to 0.5.
- **`inputSize: 512`** in `detectorOptions()` — 320 is faster, 608 is more accurate for small/distant faces in group photos.

The roster gets better with each session. Every time you confirm an existing person, that face's 128-d descriptor is added to their record, so different angles/lighting/expressions accumulate.

---

## File structure

```
index.html          UI shell (3 tabs: ATTEND, PEOPLE, REPORTS)
style.css           dark dashboard theme
firebase-config.js  your Firebase project config (you fill in)
auth.js             Google sign-in
db.js               Firestore CRUD (with auto image compression)
ml.js               face-api.js detection + recognition
app.js              main controller
firestore.rules     paste into Firestore Rules tab
```

---

## Privacy & limits

- Each Google account gets a private subtree at `users/{uid}/`. Security rules block all cross-user access.
- Face recognition runs entirely in your browser; only the resulting descriptors and photos get written to Firestore.
- Firestore free tier holds ~3,000 session photos (1 GiB total) before hitting limits. The Reset button in Reports clears everything.
- **Biometric data heads-up:** if you're tracking minors, check your school district's policy on storing facial data — most require parental consent even on a private cloud project.
