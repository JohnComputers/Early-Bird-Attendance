# ATTENDANCE.SYS

A fully client-side visual attendance tracker with face recognition. No server required — runs entirely in the browser. Designed for GitHub Pages hosting.

## Features

- **Room Setup** — Upload an empty-room photo and click to place numbered seat markers
- **Face Detection** — Upload a filled-room photo; faces are auto-detected and matched to seats
- **Face Recognition** — 128-d descriptor matching via face-api.js; learns everyone over time
- **New Person Flow** — Unknown faces trigger an identify modal to name or link them
- **Persistent Database** — All data (faces, rooms, sessions) stored in IndexedDB on-device
- **Reports** — Full session history with photo, attendee list, and seat assignments
- **Export** — Download everything as JSON or CSV; reset button to wipe all data

## Tech Stack

| Layer | Library |
|---|---|
| Face detection | face-api.js 0.22.2 (SSD MobileNet v1) |
| Face landmarks | 68-point landmark model |
| Face recognition | 128-d descriptor net |
| Storage | IndexedDB (no server) |
| Hosting | GitHub Pages (static) |

## Deploy to GitHub Pages

1. Create a new GitHub repository
2. Upload all files to the root:
   - `index.html`
   - `style.css`
   - `db.js`
   - `ml.js`
   - `app.js`
   - `404.html`
3. Go to **Settings → Pages → Source** → set to `main` branch, root `/`
4. Your site will be live at `https://<username>.github.io/<repo-name>/`

> **First load:** The face-api.js models (~6 MB) are fetched from jsDelivr CDN and cached by the browser. Subsequent loads are instant.

## Usage

### Step 1 — Setup a Room
1. Go to **01 / SETUP**
2. Upload a photo of the **empty room** (chairs visible, no people)
3. Click each chair to place a numbered marker
4. Name the room and click **SAVE ROOM LAYOUT**

### Step 2 — Take Attendance
1. Go to **02 / ATTEND**
2. Select the room from the dropdown
3. Upload a photo of the room **with people in seats**
4. The system detects faces and matches them to known people
5. Unknown faces open an **Identify** dialog — enter names or link to existing people
6. Click **SAVE ATTENDANCE**

### Step 3 — View Reports
- **03 / PEOPLE** — Full roster with thumbnails, sample counts, rename/delete
- **04 / REPORTS** — Session history, export JSON/CSV, reset all data

## Notes

- All processing is local — no photos or face data ever leave your browser
- Face descriptors are stored as Float32Arrays in IndexedDB alongside JPEG thumbnails
- People can sit in different seats on different days — the system tracks by face, not seat
- Recognition threshold is 0.52 Euclidean distance (lower = stricter). Tunable in `ml.js`
- For best results: good lighting, faces reasonably visible and forward-facing
