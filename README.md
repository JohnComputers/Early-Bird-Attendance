# ATTENDANCE.SYS

A facial-recognition attendance tracker. Mark seat positions from an empty-room photo, then auto-take attendance from a filled-room photo. Recognition runs locally in your browser; everything else lives in your own private Firestore project so it syncs across devices.

**Free tier only.** This version uses Firestore alone (no Firebase Storage, which now requires a paid plan). Photos are downscaled and embedded in Firestore documents.

---

## Features

- **Setup** — upload an empty-room photo, click chairs to mark seat positions.
- **Attendance** — upload a filled-room photo, faces are detected and matched against your roster, unknowns prompt for identification.
- **People** — auto-built roster. Each person stores multiple face samples so recognition gets better over time.
- **Reports** — full session history, JSON / CSV export, reset.
- **Sync** — sign in with Google on any device, see the same data.

---

## Setting up Firebase (one-time, ~5 minutes)

1. Create a free Firebase project
2. Enable Auth (Google) and Firestore — **that's it, no Storage needed**
3. Paste in the security rules included in this repo
4. Copy your project's config into `firebase-config.js`
5. Authorize your GitHub Pages domain

### 1 — Create the project

1. Go to [console.firebase.google.com](https://console.firebase.google.com).
2. Click **Add project**. Name it anything (e.g. `attendance-sys`). Disable Google Analytics if asked — you don't need it.
3. Wait for it to finish provisioning, then click **Continue**.

### 2 — Enable Google sign-in

1. In the left sidebar: **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Google** → toggle on, give it a public-facing project name and pick your support email → **Save**.

### 3 — Enable Firestore + paste rules

1. **Build → Firestore Database → Create database**.
2. Pick the location closest to you. Start in **production mode**.
3. Once created, go to the **Rules** tab.
4. Replace the entire contents with [`firestore.rules`](firestore.rules) from this repo. Click **Publish**.

### 4 — Get your config

1. **Project settings** (the gear icon, top-left).
2. Scroll to **Your apps** → click the **`</>`** (web) icon.
3. Nickname it (e.g. `web`). **Don't** check "Firebase Hosting". Click **Register app**.
4. Copy the `firebaseConfig` object that appears.
5. Open `firebase-config.js` in this repo and paste your values in:

   ```js
   window.FIREBASE_CONFIG = {
     apiKey:            "AIza…",
     authDomain:        "attendance-sys.firebaseapp.com",
     projectId:         "attendance-sys",
     storageBucket:     "attendance-sys.appspot.com",  // unused but Firebase includes it
     messagingSenderId: "123456789012",
     appId:             "1:1234…:web:abcd…"
   };
   ```

### 5 — Authorize your GitHub Pages domain

Sign-in only works from domains Firebase trusts.

1. **Authentication → Settings → Authorized domains → Add domain**.
2. Add `<your-username>.github.io` (just the hostname).
3. `localhost` is already there for local testing.

---

## Deploy to GitHub Pages

1. Push these files to a repo:
   ```
   index.html
   style.css
   firebase-config.js     ← with your real config
   auth.js
   db.js
   ml.js
   app.js
   firestore.rules
   README.md
   ```
2. **Settings → Pages → Source → Deploy from branch → main / root**.
3. Visit `https://<username>.github.io/<repo>/`.
4. First load: sign in with Google → ~6 MB of vision models download once → you're in.

---

## How photos are stored without Storage

The original design used Firebase Storage. Since that now requires the Blaze plan, this version takes a different approach:

- **Photos are downscaled** to max 1280px on the long edge and re-encoded as JPEG at quality 0.7 before saving.
- **The encoded image is embedded as a base64 string** directly in the Firestore document.
- If a photo still wouldn't fit, the encoder progressively reduces quality and then dimensions until it does. So uploads always succeed; very large source photos just end up a little softer.

A typical phone photo (~3 MB raw) becomes ~150–300 KB after compression, well under Firestore's 1,048,487-byte per-document limit.

The face thumbnails in the People roster are already small (200×200, ~15 KB) so they fit trivially.

---

## Free-tier capacity

The Firebase Spark (free) plan gives you:
- 50 K Firestore reads / 20 K writes / 20 K deletes per day
- 1 GiB of Firestore document data total
- Unlimited Google sign-ins

A school club with 30 people meeting twice a week is using a tiny fraction of any of these. The thing to watch is total Firestore document size — at ~300 KB per session document, you have room for **~3,000 session photos** before hitting the 1 GiB total, which is years of weekly attendance. If you ever do approach the limit, the **Reset** button in the Reports tab clears everything.

---

## Privacy

- Authentication is per-user. Each Google account gets its own private subtree at `users/{your-uid}/`.
- The security rules in this repo enforce that only the signed-in user can read or write their own data.
- **Face recognition runs entirely in your browser.** The `face-api.js` model weights are cached locally; raw images are uploaded only to your own Firestore project, never to a third-party recognition API.
- **Heads up on biometrics:** if you're tracking minors (e.g. school club members), check your district's AUP — many require parental consent for storing biometric data even on a private cloud project.

---

## File structure

```
index.html          UI shell
style.css           dark dashboard theme
firebase-config.js  YOUR project config (you fill in)
auth.js             Google sign-in wrapper
db.js               Firestore CRUD layer (with image compression)
ml.js               face-api.js setup, detection, matching
app.js              main controller
firestore.rules     paste into Firestore Rules tab
```

---

## Troubleshooting

**"Firebase is not configured"** — `firebase-config.js` still has placeholder values. Paste your real config from the Firebase console.

**"unauthorized-domain" on sign-in** — Add `<your-username>.github.io` to **Authentication → Settings → Authorized domains**.

**Sign-in pop-up immediately closes / "popup-blocked"** — the app falls back to redirect-based sign-in automatically. Just complete the Google flow and you'll land back signed in.

**"Missing or insufficient permissions"** — Your Firestore rules weren't published. Re-paste them from `firestore.rules` and click Publish.

**"document exceeds maximum size of 1048576 bytes"** — Shouldn't happen given the auto-compression, but if it does, the source photo was unusually huge (50+ MP). Resize it first in any photo viewer before uploading.

**Offline behavior** — Firestore caches reads in your browser so you can browse data offline. New writes (sessions, identifications) require connectivity and will fail offline; just reconnect and re-try.

---

## Tuning

Open `ml.js` to tweak:
- `MATCH_THRESHOLD = 0.55` — lower = stricter matching (fewer false matches, more false rejections). face-api.js default is 0.6.
- `inputSize: 512` in `detectorOptions()` — drop to 320 for faster mobile, raise to 608 for higher accuracy on big group photos.

Open `db.js` to tweak photo compression:
- `maxDim: 1280` — max dimension after downscale
- `quality: 0.7` — JPEG quality (0.6 = smaller files, 0.85 = higher quality)
