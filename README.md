# ATTENDANCE.SYS

A fully **client-side** facial-recognition attendance tracker. Mark seat positions from an empty-room photo, then take attendance from a filled-room photo. Everything runs in the browser — no server, no API keys, no data leaves your device.

Built for GitHub Pages.

---

## Features

- **Setup** — Upload a photo of an empty room, click on each chair to mark seat positions. Save the layout under a name. Multiple rooms supported.
- **Attendance** — Upload a filled-ro# ATTENDANCE.SYS

A fully **client-side** facial-recognition attendance tracker. Mark seat positions from an empty-room photo, then take attendance from a filled-room photo. Everything runs in the browser — no server, no API keys, no data leaves your device.

Built for GitHub Pages.

---

## Features

- **Setup** — Upload a photo of an empty room, click on each chair to mark seat positions. Save the layout under a name. Multiple rooms supported.
- **Attendance** — Upload a filled-room photo. Faces are detected, matched against your roster, and assigned to the nearest chair. Unknown faces prompt you to identify them (pick existing person or new name).
- **People** — Roster of everyone the system has learned. Each person stores multiple face samples for better recognition over time.
- **Reports** — Full session history with date, room, attendance count, and who was there. Export to JSON or CSV. Reset the entire database with a typed confirmation.
- **Persistence** — Everything stored in IndexedDB (rooms, people, sessions including the original photos). Survives page reloads.

---

## Deploy to GitHub Pages

1. Create a new repo (any name).
2. Drop these files in the root:
   ```
   index.html
   style.css
   db.js
   ml.js
   app.js
   README.md
   ```
3. Push to `main`.
4. Repo → **Settings → Pages → Source → Deploy from branch → main / root**.
5. Visit `https://<username>.github.io/<repo>/`.

First load downloads ~6 MB of model weights (face detector + landmarks + recognition net) from a public CDN; subsequent loads use the browser cache.

---

## How it works

| Layer | What |
|---|---|
| **face-api.js** | Loaded from `cdn.jsdelivr.net`. Uses TinyFaceDetector (fast), 68-point landmarks, and the FaceNet-style 128-d descriptor. |
| **Models** | Pulled from `cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights` (jsdelivr serving the original GitHub repo). Falls back to `justadudewhohacks.github.io/face-api.js/models`. |
| **Recognition** | Each detected face becomes a 128-float vector. New faces are matched against the roster by Euclidean distance with a tightened threshold of `0.55` (face-api default is 0.6). Match → log attendance. No match → prompt for identification. |
| **Storage** | Three IndexedDB stores: `rooms`, `people`, `sessions`. Image blobs are stored directly; descriptors as `Float32Array`. |
| **Seat assignment** | Greedy nearest-pair: the closest face↔chair pair is matched first, then the next, until everyone or every seat is taken. People not near any chair are recorded as "off-seat". |

---

## Privacy

Everything stays in your browser. The only network calls are:
- Loading `face-api.js` (script) and the model weights (JSON + binary shards) from a public CDN on first load.
- Loading Google Fonts (visual only).

No telemetry, no servers, no analytics. Opening DevTools → Network confirms there are zero outbound requests once models cache.

---

## Notes & limits

- **Photo angle matters.** The chair layout you mark in Setup is in image coordinates. Take attendance photos from a roughly similar angle so the seat positions still line up. People are still recognized regardless of seat — the seat is just metadata.
- **Recognition improves with use.** Each time you confirm an existing person, that face's descriptor is *added* to their record. After a few sessions the system gets noticeably more reliable across lighting/angle/expression changes.
- **Threshold tuning.** If you get false matches, increase strictness in `ml.js` (`MATCH_THRESHOLD = 0.55` → `0.5`). If you get false rejections, loosen to `0.6`.
- **Detector size.** TinyFaceDetector is set to `inputSize: 512`. Drop to `320` for faster mobile detection at the cost of small-face accuracy, or raise to `608` for higher quality on big group photos.

---

## File structure

```
index.html      — UI shell, four tabs, modals
style.css       — dark dashboard theme
db.js           — IndexedDB wrapper (rooms, people, sessions, export, reset)
ml.js           — face-api.js setup, detection, matching, chair assignment
app.js          — main controller, event wiring, all UI logic
```

Open in any modern browser. No build step. No node_modules. No backend.
om photo. Faces are detected, matched against your roster, and assigned to the nearest chair. Unknown faces prompt you to identify them (pick existing person or new name).
- **People** — Roster of everyone the system has learned. Each person stores multiple face samples for better recognition over time.
- **Reports** — Full session history with date, room, attendance count, and who was there. Export to JSON or CSV. Reset the entire database with a typed confirmation.
- **Persistence** — Everything stored in IndexedDB (rooms, people, sessions including the original photos). Survives page reloads.

---

## Deploy to GitHub Pages

1. Create a new repo (any name).
2. Drop these files in the root:
   ```
   index.html
   style.css
   db.js
   ml.js
   app.js
   README.md
   ```
3. Push to `main`.
4. Repo → **Settings → Pages → Source → Deploy from branch → main / root**.
5. Visit `https://<username>.github.io/<repo>/`.

First load downloads ~6 MB of model weights (face detector + landmarks + recognition net) from a public CDN; subsequent loads use the browser cache.

---

## How it works

| Layer | What |
|---|---|
| **face-api.js** | Loaded from `cdn.jsdelivr.net`. Uses TinyFaceDetector (fast), 68-point landmarks, and the FaceNet-style 128-d descriptor. |
| **Models** | Pulled from `cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights` (jsdelivr serving the original GitHub repo). Falls back to `justadudewhohacks.github.io/face-api.js/models`. |
| **Recognition** | Each detected face becomes a 128-float vector. New faces are matched against the roster by Euclidean distance with a tightened threshold of `0.55` (face-api default is 0.6). Match → log attendance. No match → prompt for identification. |
| **Storage** | Three IndexedDB stores: `rooms`, `people`, `sessions`. Image blobs are stored directly; descriptors as `Float32Array`. |
| **Seat assignment** | Greedy nearest-pair: the closest face↔chair pair is matched first, then the next, until everyone or every seat is taken. People not near any chair are recorded as "off-seat". |

---

## Privacy

Everything stays in your browser. The only network calls are:
- Loading `face-api.js` (script) and the model weights (JSON + binary shards) from a public CDN on first load.
- Loading Google Fonts (visual only).

No telemetry, no servers, no analytics. Opening DevTools → Network confirms there are zero outbound requests once models cache.

---

## Notes & limits

- **Photo angle matters.** The chair layout you mark in Setup is in image coordinates. Take attendance photos from a roughly similar angle so the seat positions still line up. People are still recognized regardless of seat — the seat is just metadata.
- **Recognition improves with use.** Each time you confirm an existing person, that face's descriptor is *added* to their record. After a few sessions the system gets noticeably more reliable across lighting/angle/expression changes.
- **Threshold tuning.** If you get false matches, increase strictness in `ml.js` (`MATCH_THRESHOLD = 0.55` → `0.5`). If you get false rejections, loosen to `0.6`.
- **Detector size.** TinyFaceDetector is set to `inputSize: 512`. Drop to `320` for faster mobile detection at the cost of small-face accuracy, or raise to `608` for higher quality on big group photos.

---

## File structure

```
index.html      — UI shell, four tabs, modals
style.css       — dark dashboard theme
db.js           — IndexedDB wrapper (rooms, people, sessions, export, reset)
ml.js           — face-api.js setup, detection, matching, chair assignment
app.js          — main controller, event wiring, all UI logic
```

Open in any modern browser. No build step. No node_modules. No backend.
