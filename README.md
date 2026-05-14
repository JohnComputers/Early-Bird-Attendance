# ATTENDANCE.SYS

Face-recognition attendance tracking. **Click on each person's face in a photo**; the system recognizes who they are. New faces prompt you for a name, and recognition gets better every time. All data lives in your private Firestore project.

---

## How it works

1. **Upload a photo** of the people present.
2. **Click on each person's face.** Each click runs focused face detection on a region around that point, then matches the descriptor against your roster.
3. **Identify any unknowns** — the modal asks you to pick from existing people or type a new name.
4. **Save the session.** It's logged with the date, optional label, the photo, and who was there.
5. **Reports** show every session ever taken. Export as JSON or CSV.

The **AUTO-DETECT FACES** button is a helper — it scans the whole photo and places markers automatically. Use it when face detection works well on your photo; click manually for anyone it missed. Manual clicks always work because the model only has to find a face in the small region around your click, not in the whole photo.

---

## Marker states

When you click on the photo, a marker is placed and the face recognition runs asynchronously (~50-300ms):

- **Pending** (blue pulsing circle) — currently being processed.
- **Detected, known** (green box + name) — matched against your roster.
- **Detected, unknown** (orange box + "NEW?") — face detected but not recognized; will prompt you to name them.
- **Failed** (red X) — no face found in that region. Click it to remove and try again with a more precise click on the actual face.

Click any marker to remove it (works on knowns, unknowns, pending, or failed alike).

---

## Setting up Firebase (one-time, ~5 minutes)

1. Create a free Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable Authentication → Google sign-in
3. Enable Firestore (production mode) and paste the rules from [`firestore.rules`](firestore.rules) into the Firestore Rules tab
4. Project Settings → Your apps → `</>` web → register an app → copy the config object into `firebase-config.js`
5. Authentication → Settings → Authorized domains → add `<your-username>.github.io`

**No Firebase Storage needed** — photos are downscaled and embedded in Firestore documents to stay on the free tier.

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

- **`MATCH_THRESHOLD = 0.55`** in the constants — lower = stricter matching. If known people keep coming up as "NEW?", raise it to 0.6 or 0.65. If different people are getting matched to each other, drop to 0.5. face-api.js default is 0.6.
- **`scoreThreshold: 0.2`** inside `detectFaceNearPoint` — how sensitive the focused detector is. Already very lenient since we know there's a face where the user clicked.
- **`regionSize: 30%`** inside `detectFaceNearPoint` — how much area around each click is searched for a face. Increase if very small faces aren't getting found.

The roster gets better with each session. Every time you confirm an existing person, that face's 128-d descriptor is added to their record. Different angles, lighting, and expressions accumulate over time.

---

## File structure

```
index.html          UI shell (3 tabs: ATTEND, PEOPLE, REPORTS)
style.css           dark dashboard theme
firebase-config.js  your Firebase project config (you fill in)
auth.js             Google sign-in wrapper
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
