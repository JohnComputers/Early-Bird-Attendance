/* =========================================================
   app.js — ATTENDANCE.SYS application logic
   Tabs: Setup · Attendance · People · Reports
========================================================= */

/* =========================================================
   GLOBAL STATE
========================================================= */
const S = {
  // Setup tab
  setup: {
    imageEl:   null,   // HTMLImageElement
    imageBlob: null,   // File / Blob
    chairs:    [],     // [{x,y}] fractions 0-1 of image dimensions
    naturalW:  0,
    naturalH:  0,
  },
  // Attendance tab
  att: {
    roomId:    null,
    room:      null,
    imageEl:   null,
    imageBlob: null,
    matches:   [],   // [{tempId, detection, person|null, distance, cropBlob, cropUrl, isNew, newName, chairIndex}]
  },
  people:   [],  // cached from DB
  sessions: [],  // cached from DB
};

/* =========================================================
   UTILS
========================================================= */
function el(id) { return document.getElementById(id); }

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toast(msg, type = 'ok', ms = 3200) {
  const t = el('toast');
  t.textContent = msg;
  t.className   = `toast${type === 'error' ? ' error' : ''}`;
  t.classList.remove('hidden');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.add('hidden'), ms);
}

function setStatus(msg, state = '') {
  el('statusText').textContent = msg;
  el('statusDot').className    = 'stat-dot' + (state ? ' ' + state : '');
}

function setModelStatus(msg) {
  el('statusModel').textContent = 'MODELS: ' + msg;
}

async function updateMeta() {
  const c = await DB.counts();
  el('metaPeople').textContent   = c.people;
  el('metaSessions').textContent = c.sessions;
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload  = () => { img._objectUrl = url; resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
    + '  ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function blobUrl(blob) { return blob ? URL.createObjectURL(blob) : null; }

/* =========================================================
   BOOT
========================================================= */
async function boot() {
  const logEl   = el('bootLog');
  const progEl  = el('bootProgress');
  const statEl  = el('bootStatus');

  function log(html) {
    logEl.innerHTML += html + '\n';
    logEl.scrollTop  = logEl.scrollHeight;
  }
  function progress(pct, label) {
    progEl.style.width = pct + '%';
    if (label) statEl.textContent = label;
  }

  try {
    log('> Opening IndexedDB…');
    progress(4, 'OPENING DATABASE…');
    await DB.open();
    log('> Database ready.');
    progress(8, 'LOADING VISION MODELS…');

    await ML.loadModels(
      html => log(html),
      pct  => progress(8 + pct * 0.90, 'LOADING VISION MODELS…')
    );

    progress(100, 'SYSTEM READY');
    log('> <b>Boot complete.</b>');

    // Prime caches
    S.people   = await DB.getPeople();
    S.sessions = await DB.getSessions();
    await updateMeta();

    setTimeout(() => {
      el('boot').classList.add('done');
      setTimeout(() => { el('boot').style.display = 'none'; }, 450);
    }, 500);

    setStatus('System ready.', 'ok');
    setModelStatus('loaded');

    // Populate initial UI
    renderRoomsList();
    renderRoomSelect();
    renderPeople();
    renderReports();

  } catch (err) {
    log(`> <b>ERROR: ${escHtml(err.message)}</b>`);
    progress(100, 'BOOT ERROR');
    setStatus('Boot failed — ' + err.message, 'error');
    setModelStatus('error');
    console.error('[BOOT]', err);
  }
}

/* =========================================================
   TABS
========================================================= */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    el(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'people')  renderPeople();
    if (btn.dataset.tab === 'reports') renderReports();
  });
});

/* =========================================================
   01 / SETUP — Chair placement
========================================================= */
const setupCanvas = el('setupCanvas');
const setupCtx    = setupCanvas.getContext('2d');

el('setupFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;

  S.setup.imageBlob = file;
  const img = await loadImage(file);
  S.setup.imageEl  = img;
  S.setup.naturalW = img.naturalWidth;
  S.setup.naturalH = img.naturalHeight;
  S.setup.chairs   = [];

  // Size canvas to fit container while preserving aspect
  const wrap   = setupCanvas.parentElement;
  const maxW   = (wrap.clientWidth  || 900) - 4;
  const maxH   = Math.min(window.innerHeight * 0.65, 680);
  const scale  = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  setupCanvas.width  = Math.round(img.naturalWidth  * scale);
  setupCanvas.height = Math.round(img.naturalHeight * scale);

  el('imgDims').textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
  el('setupEmpty').classList.add('hidden');
  setupCanvas.classList.remove('hidden');

  drawSetup();
  el('clearChairsBtn').disabled = false;
  el('saveRoomBtn').disabled    = true; // need at least 1 chair
  updateSeatCount();
});

setupCanvas.addEventListener('click', e => {
  if (!S.setup.imageEl) return;

  const rect = setupCanvas.getBoundingClientRect();
  // canvas pixel coords (accounting for CSS scaling)
  const cx = (e.clientX - rect.left)  * (setupCanvas.width  / rect.width);
  const cy = (e.clientY - rect.top)   * (setupCanvas.height / rect.height);

  // Fraction of image
  const fx = cx / setupCanvas.width;
  const fy = cy / setupCanvas.height;

  // Hit-test existing markers (~20 canvas px radius)
  const HIT = 20;
  const hitIdx = S.setup.chairs.findIndex(c => {
    const px = c.x * setupCanvas.width;
    const py = c.y * setupCanvas.height;
    return Math.hypot(px - cx, py - cy) < HIT;
  });

  if (hitIdx >= 0) {
    S.setup.chairs.splice(hitIdx, 1);
  } else {
    S.setup.chairs.push({ x: fx, y: fy });
  }

  drawSetup();
  updateSeatCount();
});

function drawSetup() {
  const img = S.setup.imageEl;
  if (!img) return;
  const W = setupCanvas.width;
  const H = setupCanvas.height;

  setupCtx.clearRect(0, 0, W, H);
  setupCtx.drawImage(img, 0, 0, W, H);

  // Slight darken so markers pop
  setupCtx.fillStyle = 'rgba(0,0,0,0.18)';
  setupCtx.fillRect(0, 0, W, H);

  S.setup.chairs.forEach((c, i) => {
    const px = c.x * W;
    const py = c.y * H;
    const num = String(i + 1);

    // Outer ring
    setupCtx.beginPath();
    setupCtx.arc(px, py, 20, 0, Math.PI * 2);
    setupCtx.strokeStyle = 'rgba(200,255,0,0.35)';
    setupCtx.lineWidth   = 1;
    setupCtx.stroke();

    // Filled circle
    setupCtx.beginPath();
    setupCtx.arc(px, py, 13, 0, Math.PI * 2);
    setupCtx.fillStyle = '#c8ff00';
    setupCtx.fill();

    // Number label
    const fontSize = num.length > 1 ? 9 : 11;
    setupCtx.font          = `bold ${fontSize}px "JetBrains Mono", monospace`;
    setupCtx.fillStyle     = '#0a0d0a';
    setupCtx.textAlign     = 'center';
    setupCtx.textBaseline  = 'middle';
    setupCtx.fillText(num, px, py);
  });
}

function updateSeatCount() {
  el('seatCount').textContent     = S.setup.chairs.length;
  el('saveRoomBtn').disabled      = S.setup.chairs.length === 0 || !S.setup.imageEl;
  el('clearChairsBtn').disabled   = S.setup.chairs.length === 0;
}

el('clearChairsBtn').addEventListener('click', () => {
  S.setup.chairs = [];
  drawSetup();
  updateSeatCount();
});

el('saveRoomBtn').addEventListener('click', async () => {
  if (!S.setup.imageEl || S.setup.chairs.length === 0) {
    toast('Upload a photo and mark at least one seat.', 'error');
    return;
  }
  const name = el('roomName').value.trim() || 'Unnamed Room';
  setStatus('Saving room…', 'busy');
  try {
    const id = await DB.addRoom({
      name,
      createdAt: new Date().toISOString(),
      chairs:    [...S.setup.chairs],
      imageBlob: S.setup.imageBlob,
      imageW:    S.setup.naturalW,
      imageH:    S.setup.naturalH,
    });
    toast(`"${name}" saved — ${S.setup.chairs.length} seats.`);
    setStatus('Room saved.', 'ok');
    el('roomName').value = '';
    await renderRoomsList();
    await renderRoomSelect();
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
    setStatus('Error.', 'error');
  }
});

async function renderRoomsList() {
  const rooms = await DB.getRooms();
  const cont  = el('roomsList');
  if (!rooms.length) {
    cont.innerHTML = '<p class="muted">No rooms saved yet.</p>';
    return;
  }
  cont.innerHTML = rooms.map(r => `
    <div class="room-item">
      <div>
        <div class="room-item-name">${escHtml(r.name)}</div>
        <div class="room-item-meta">${r.chairs.length} seats · ${new Date(r.createdAt).toLocaleDateString()}</div>
      </div>
      <button class="x" data-del-room="${r.id}" title="Delete room">×</button>
    </div>`).join('');

  cont.querySelectorAll('[data-del-room]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this room? Saved sessions won\'t be affected.')) return;
      await DB.deleteRoom(Number(btn.dataset.delRoom));
      renderRoomsList();
      renderRoomSelect();
      toast('Room deleted.');
    });
  });
}

/* =========================================================
   02 / ATTENDANCE
========================================================= */
const attCanvas = el('attCanvas');
const attCtx    = attCanvas.getContext('2d');

async function renderRoomSelect() {
  const rooms = await DB.getRooms();
  el('attRoomSelect').innerHTML =
    '<option value="">— Select a room —</option>' +
    rooms.map(r => `<option value="${r.id}">${escHtml(r.name)} (${r.chairs.length} seats)</option>`).join('');
}

el('attRoomSelect').addEventListener('change', e => {
  S.att.roomId = e.target.value ? Number(e.target.value) : null;
  resetAttState();
});

el('attFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  if (!S.att.roomId) { toast('Select a room first.', 'error'); return; }

  S.att.imageBlob = file;

  try {
    S.att.imageEl = await loadImage(file);
    S.att.room    = await DB.getRoom(S.att.roomId);
    S.people      = await DB.getPeople();
  } catch (err) {
    toast('Could not load image: ' + err.message, 'error');
    return;
  }

  // Resize canvas
  const wrap  = attCanvas.parentElement;
  const maxW  = (wrap.clientWidth  || 900) - 4;
  const maxH  = Math.min(window.innerHeight * 0.65, 680);
  const scale = Math.min(maxW / S.att.imageEl.naturalWidth, maxH / S.att.imageEl.naturalHeight, 1);
  attCanvas.width  = Math.round(S.att.imageEl.naturalWidth  * scale);
  attCanvas.height = Math.round(S.att.imageEl.naturalHeight * scale);

  attCtx.drawImage(S.att.imageEl, 0, 0, attCanvas.width, attCanvas.height);
  el('attEmpty').classList.add('hidden');
  attCanvas.classList.remove('hidden');

  setStatus('Running face detection…', 'busy');
  setModelStatus('detecting…');

  try {
    const detections = await ML.detectFaces(S.att.imageEl);

    if (detections.length === 0) {
      setStatus('No faces detected. Try a clearer photo.', 'ok');
      setModelStatus('idle');
      toast('No faces detected — try a higher-res or well-lit photo.', 'error', 5000);
      el('facesCount').textContent  = '0';
      el('recCount').textContent    = '0';
      el('unkCount').textContent    = '0';
      el('seatsFilled').textContent = '0 / ' + (S.att.room?.chairs.length || '?');
      el('saveSessionBtn').disabled   = false; // allow saving an empty session
      el('discardSessionBtn').disabled = false;
      return;
    }

    // Build match objects
    S.att.matches = await Promise.all(detections.map(async (det, i) => {
      const matchResult = ML.matchFace(det.descriptor, S.people);
      const cropBlob    = await ML.cropFace(S.att.imageEl, det);
      return {
        tempId:    i,
        detection: det,
        person:    matchResult ? matchResult.person : null,
        distance:  matchResult ? matchResult.distance : null,
        cropBlob,
        cropUrl:   URL.createObjectURL(cropBlob),
        isNew:     false,
        newName:   '',
        chairIndex: null,
      };
    }));

    // Spatially assign faces to chair slots
    assignChairsToFaces();

    drawAttCanvas();
    renderAttendees();

    const knownCount = S.att.matches.filter(m => m.person).length;
    const unkCount   = S.att.matches.length - knownCount;

    el('facesCount').textContent  = detections.length;
    el('recCount').textContent    = knownCount;
    el('unkCount').textContent    = unkCount;
    el('seatsFilled').textContent =
      S.att.matches.filter(m => m.chairIndex !== null).length + ' / ' + (S.att.room?.chairs.length || '?');

    el('saveSessionBtn').disabled    = false;
    el('discardSessionBtn').disabled = false;

    setStatus(`Detected ${detections.length} face(s). ${unkCount} unknown.`, 'ok');
    setModelStatus('idle');

    // Auto-open identify modal for unknowns
    const unknowns = S.att.matches.filter(m => !m.person);
    if (unknowns.length > 0) {
      openIdentifyModal(unknowns);
    }

  } catch (err) {
    setStatus('Detection failed: ' + err.message, 'error');
    setModelStatus('error');
    toast('Face detection error: ' + err.message, 'error');
    console.error('[DETECT]', err);
  }
});

/* Greedy nearest-chair assignment */
function assignChairsToFaces() {
  if (!S.att.room?.chairs.length) return;
  const chairs = S.att.room.chairs;
  const imgW   = S.att.imageEl.naturalWidth;
  const imgH   = S.att.imageEl.naturalHeight;

  // Face centres as normalised fractions
  const centres = S.att.matches.map(m => {
    const b = m.detection.detection.box;
    return { x: (b.x + b.width / 2) / imgW, y: (b.y + b.height / 2) / imgH };
  });

  const usedChairs = new Set();

  // Compute all (face, chair) distances, sort ascending, greedily assign
  const pairs = [];
  centres.forEach((fc, fi) => {
    chairs.forEach((c, ci) => {
      pairs.push({ fi, ci, dist: Math.hypot(c.x - fc.x, c.y - fc.y) });
    });
  });
  pairs.sort((a, b) => a.dist - b.dist);

  const assignedFaces = new Set();
  for (const p of pairs) {
    if (assignedFaces.has(p.fi) || usedChairs.has(p.ci)) continue;
    S.att.matches[p.fi].chairIndex = p.ci;
    assignedFaces.add(p.fi);
    usedChairs.add(p.ci);
  }
}

function drawAttCanvas() {
  const img  = S.att.imageEl;
  if (!img) return;
  const W    = attCanvas.width;
  const H    = attCanvas.height;
  const scX  = W / img.naturalWidth;
  const scY  = H / img.naturalHeight;

  attCtx.clearRect(0, 0, W, H);
  attCtx.drawImage(img, 0, 0, W, H);

  // Draw empty chair slots first (dimmed)
  if (S.att.room?.chairs) {
    S.att.room.chairs.forEach((c, i) => {
      if (S.att.matches.some(m => m.chairIndex === i)) return;
      const px = c.x * W;
      const py = c.y * H;
      attCtx.beginPath();
      attCtx.arc(px, py, 14, 0, Math.PI * 2);
      attCtx.fillStyle   = 'rgba(0,0,0,0.45)';
      attCtx.strokeStyle = 'rgba(255,255,255,0.25)';
      attCtx.lineWidth   = 1;
      attCtx.fill();
      attCtx.stroke();
      attCtx.font          = '9px "JetBrains Mono",monospace';
      attCtx.fillStyle     = 'rgba(255,255,255,0.35)';
      attCtx.textAlign     = 'center';
      attCtx.textBaseline  = 'middle';
      attCtx.fillText(i + 1, px, py);
    });
  }

  // Draw face boxes
  S.att.matches.forEach(m => {
    const b     = m.detection.detection.box;
    const x     = b.x * scX;
    const y     = b.y * scY;
    const w     = b.width  * scX;
    const h     = b.height * scY;
    const known = !!m.person;
    const color = known ? '#c8ff00' : '#ffb547';
    const name  = m.person ? m.person.name : (m.newName || 'UNKNOWN');
    const chairTxt = m.chairIndex !== null ? ` ·S${m.chairIndex + 1}` : '';

    // Face box
    attCtx.strokeStyle = color;
    attCtx.lineWidth   = 2;
    attCtx.strokeRect(x, y, w, h);

    // Corner brackets
    const cs = 10;
    attCtx.strokeStyle = '#fff';
    attCtx.lineWidth   = 1.5;
    [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([bx,by]) => {
      const dx = bx === x ? 1 : -1;
      const dy = by === y ? 1 : -1;
      attCtx.beginPath();
      attCtx.moveTo(bx + dx * cs, by);
      attCtx.lineTo(bx, by);
      attCtx.lineTo(bx, by + dy * cs);
      attCtx.stroke();
    });

    // Label bar
    const lh = 20;
    attCtx.fillStyle = known ? 'rgba(200,255,0,0.88)' : 'rgba(255,181,71,0.88)';
    attCtx.fillRect(x, y - lh, w, lh);
    attCtx.fillStyle     = '#0a0d0a';
    attCtx.font          = `bold 9px "JetBrains Mono",monospace`;
    attCtx.textAlign     = 'left';
    attCtx.textBaseline  = 'middle';
    // Truncate long names
    const label = (name.length > 18 ? name.slice(0, 16) + '…' : name) + chairTxt;
    attCtx.fillText(label, x + 4, y - lh / 2);
  });
}

function renderAttendees() {
  const card = el('attendeesCard');
  const list = el('attendeesList');

  if (!S.att.matches.length) { card.hidden = true; return; }
  card.hidden = false;

  list.innerHTML = '<div class="attendees">' +
    S.att.matches.map(m => {
      const name  = m.person ? m.person.name : (m.newName || 'UNKNOWN');
      const badge = m.person
        ? `<span class="badge ok">KNOWN</span>`
        : `<span class="badge new">NEW</span>`;
      const chair = m.chairIndex !== null ? `Seat ${m.chairIndex + 1}` : 'No seat';
      const dist  = m.distance ? ` · ${m.distance.toFixed(2)}` : '';
      return `<div class="attendee${m.person ? '' : ' unk'}">
        <img src="${m.cropUrl}" alt="${escHtml(name)}" />
        <div class="info">
          <b>${escHtml(name)}</b>
          <small>${escHtml(chair)}${dist}</small>
        </div>
        ${badge}
      </div>`;
    }).join('') + '</div>';
}

function resetAttState() {
  // Revoke old crop object URLs
  S.att.matches.forEach(m => { if (m.cropUrl) URL.revokeObjectURL(m.cropUrl); });
  S.att.matches   = [];
  S.att.imageEl   = null;
  S.att.imageBlob = null;

  el('attEmpty').classList.remove('hidden');
  attCanvas.classList.add('hidden');
  attCtx.clearRect(0, 0, attCanvas.width, attCanvas.height);

  el('facesCount').textContent   = '—';
  el('recCount').textContent     = '—';
  el('unkCount').textContent     = '—';
  el('seatsFilled').textContent  = '—';
  el('attendeesCard').hidden     = true;
  el('saveSessionBtn').disabled   = true;
  el('discardSessionBtn').disabled = true;
}

el('discardSessionBtn').addEventListener('click', () => {
  resetAttState();
  el('attFile').value = '';
  toast('Session discarded.');
});

el('saveSessionBtn').addEventListener('click', async () => {
  setStatus('Saving session…', 'busy');
  try {
    const attendees = S.att.matches.map(m => ({
      personId:    m.person?.id ?? null,
      name:        m.person ? m.person.name : (m.newName || 'Anonymous'),
      chairIndex:  m.chairIndex,
      isNew:       m.isNew,
    }));

    await DB.addSession({
      date:         new Date().toISOString(),
      roomId:       S.att.roomId,
      roomName:     S.att.room?.name ?? 'Unknown Room',
      imageBlob:    S.att.imageBlob,
      attendees,
      seatCount:    S.att.room?.chairs.length ?? 0,
      presentCount: attendees.length,
    });

    S.sessions = await DB.getSessions();
    await updateMeta();
    toast(`Session saved — ${attendees.length} present.`);
    setStatus('Session saved.', 'ok');
    resetAttState();
    el('attFile').value = '';

  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
    setStatus('Save failed.', 'error');
    console.error('[SAVE SESSION]', err);
  }
});

/* =========================================================
   IDENTIFY MODAL
========================================================= */
function openIdentifyModal(unknowns) {
  const list = el('identifyList');

  list.innerHTML = unknowns.map((m, idx) => `
    <div class="identify-item" data-face-id="${m.tempId}">
      <img src="${m.cropUrl}" alt="Unknown face ${idx + 1}" />
      <div class="controls">
        <div style="font-size:10px;color:var(--text-dim);letter-spacing:.1em;margin-bottom:4px">
          FACE ${idx + 1}
        </div>
        <div class="row">
          <select class="select isel" data-face="${m.tempId}" style="min-width:0;flex:1">
            <option value="__new__">+ New person</option>
            ${S.people.map(p =>
              `<option value="${p.id}">${escHtml(p.name)}</option>`
            ).join('')}
            <option value="__skip__">Skip (anonymous)</option>
          </select>
        </div>
        <div class="row iname-row" data-for="${m.tempId}" style="display:flex">
          <input type="text" class="iname" data-face="${m.tempId}"
            placeholder="Full name…" style="flex:1;min-width:0" />
        </div>
      </div>
    </div>`).join('');

  // Toggle name input visibility
  list.querySelectorAll('.isel').forEach(sel => {
    const toggle = () => {
      const row = list.querySelector(`.iname-row[data-for="${sel.dataset.face}"]`);
      if (row) row.style.display = sel.value === '__new__' ? 'flex' : 'none';
    };
    sel.addEventListener('change', toggle);
    toggle();
  });

  el('identifyModal').classList.remove('hidden');
}

el('modalCloseBtn').addEventListener('click',  () => el('identifyModal').classList.add('hidden'));
el('modalCancelBtn').addEventListener('click', () => el('identifyModal').classList.add('hidden'));

el('modalConfirmBtn').addEventListener('click', async () => {
  const items = el('identifyList').querySelectorAll('.identify-item');
  let hasError = false;

  for (const item of items) {
    const faceId = Number(item.dataset.faceId);
    const m      = S.att.matches.find(x => x.tempId === faceId);
    if (!m) continue;

    const sel  = item.querySelector('.isel');
    const inp  = item.querySelector('.iname');

    if (sel.value === '__skip__') {
      m.newName = 'Anonymous';
      continue;
    }

    if (sel.value === '__new__') {
      const name = inp?.value.trim() ?? '';
      if (!name) {
        inp?.focus();
        toast('Enter a name for every new face.', 'error');
        hasError = true;
        break;
      }
      // Create person
      const newPerson = {
        name,
        createdAt:   new Date().toISOString(),
        descriptors: [Array.from(m.detection.descriptor)],
        thumbBlob:   m.cropBlob,
        sessionCount: 0,
      };
      const newId = await DB.addPerson(newPerson);
      newPerson.id = newId;
      m.person  = newPerson;
      m.newName = name;
      m.isNew   = true;
      S.people.push(newPerson);

    } else {
      // Merge descriptor into existing person
      const pid    = Number(sel.value);
      const person = await DB.getPerson(pid);
      if (person) {
        person.descriptors = [...(person.descriptors ?? []), Array.from(m.detection.descriptor)];
        // Update thumbnail if none exists
        if (!person.thumbBlob) person.thumbBlob = m.cropBlob;
        await DB.updatePerson(person);
        m.person = person;
        const idx = S.people.findIndex(p => p.id === pid);
        if (idx >= 0) S.people[idx] = person;
      }
    }
  }

  if (hasError) return;

  el('identifyModal').classList.add('hidden');
  await updateMeta();

  // Refresh counts
  el('recCount').textContent = S.att.matches.filter(m => m.person).length;
  el('unkCount').textContent = S.att.matches.filter(m => !m.person).length;

  drawAttCanvas();
  renderAttendees();
  toast('Faces identified!');
  setStatus('Identifications applied.', 'ok');
});

/* =========================================================
   03 / PEOPLE
========================================================= */
el('peopleSearch').addEventListener('input', e => {
  renderPeople(e.target.value.trim().toLowerCase());
});

async function renderPeople(filter = '') {
  const people   = await DB.getPeople();
  S.people       = people;
  const grid     = el('peopleGrid');
  const filtered = filter
    ? people.filter(p => p.name.toLowerCase().includes(filter))
    : people;

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-block">
      <h3>${filter ? 'NO MATCHES' : 'NO PEOPLE YET'}</h3>
      <p>${filter
        ? `Nobody named "${escHtml(filter)}" found.`
        : 'The roster fills automatically as you identify faces during attendance.'
      }</p>
    </div>`;
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const thumbUrl = p.thumbBlob ? URL.createObjectURL(p.thumbBlob) : null;
    const samples  = (p.descriptors ?? []).length;
    const since    = new Date(p.createdAt).toLocaleDateString();
    return `<div class="person-card">
      ${thumbUrl
        ? `<img class="person-thumb" src="${thumbUrl}" alt="${escHtml(p.name)}" />`
        : `<div class="person-thumb-placeholder">?</div>`
      }
      <div class="person-meta">
        <h4 class="person-name">${escHtml(p.name)}</h4>
        <div class="person-stats">${samples} SAMPLE${samples !== 1 ? 'S' : ''} · SINCE ${since}</div>
      </div>
      <div class="person-actions">
        <button data-rename="${p.id}">RENAME</button>
        <button class="del" data-delete="${p.id}">DELETE</button>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('[data-rename]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const person = await DB.getPerson(Number(btn.dataset.rename));
      if (!person) return;
      const name = prompt('Rename:', person.name);
      if (!name?.trim()) return;
      person.name = name.trim();
      await DB.updatePerson(person);
      toast('Name updated.');
      renderPeople(filter);
    });
  });

  grid.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this person from the roster?\nSession history is kept.')) return;
      await DB.deletePerson(Number(btn.dataset.delete));
      S.people = await DB.getPeople();
      await updateMeta();
      toast('Person removed.');
      renderPeople(filter);
    });
  });
}

/* =========================================================
   04 / REPORTS
========================================================= */
async function renderReports() {
  const sessions = await DB.getSessions();
  const rooms    = await DB.getRooms();
  S.sessions     = sessions;

  const totalPresent = sessions.reduce((s, x) => s + (x.presentCount ?? 0), 0);
  const uniquePeople = new Set(
    sessions.flatMap(s => s.attendees.map(a => a.personId).filter(Boolean))
  ).size;

  el('reportsSummary').innerHTML = `
    <div class="summary-box"><div class="v">${sessions.length}</div><div class="k">Total Sessions</div></div>
    <div class="summary-box"><div class="v">${totalPresent}</div><div class="k">Total Check-ins</div></div>
    <div class="summary-box"><div class="v">${uniquePeople}</div><div class="k">Unique People</div></div>
    <div class="summary-box"><div class="v">${rooms.length}</div><div class="k">Rooms</div></div>
  `;

  const tbody = el('sessionsTbody');
  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted center">No sessions recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = [...sessions].reverse().map(s => {
    const pills = s.attendees.map(a =>
      `<span class="att-pill${a.personId ? '' : ' unk'}">${escHtml(a.name)}</span>`
    ).join('');
    return `<tr>
      <td style="white-space:nowrap;color:var(--text-dim);font-size:11px">${formatDate(s.date)}</td>
      <td style="font-weight:700">${escHtml(s.roomName)}</td>
      <td style="color:var(--accent);font-weight:700">${s.presentCount}</td>
      <td style="color:var(--text-dim)">${s.seatCount || '—'}</td>
      <td>${pills}</td>
      <td>
        <button class="btn ghost" style="padding:5px 10px;font-size:10px"
          data-view="${s.id}">VIEW</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const session = await DB.getSession(Number(btn.dataset.view));
      openSessionModal(session);
    });
  });
}

el('exportJsonBtn').addEventListener('click', async () => {
  setStatus('Exporting JSON…', 'busy');
  try {
    const data = await DB.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `attendance_${isoDate()}.json`);
    setStatus('Export done.', 'ok');
    toast('JSON exported.');
  } catch (err) {
    toast('Export failed: ' + err.message, 'error');
    setStatus('Export failed.', 'error');
  }
});

el('exportCsvBtn').addEventListener('click', async () => {
  const sessions = await DB.getSessions();
  const rows = [
    ['Date','Room','Present','Total Seats','Attendees'],
    ...sessions.map(s => [
      s.date, s.roomName, s.presentCount, s.seatCount,
      s.attendees.map(a => a.name).join('; '),
    ]),
    [],
    ['--- PER-PERSON DETAIL ---'],
    ['Date','Room','Person','Seat','Is New','Person ID'],
    ...sessions.flatMap(s => s.attendees.map(a => [
      s.date, s.roomName, a.name,
      a.chairIndex !== null ? `Seat ${a.chairIndex + 1}` : '',
      a.isNew ? 'YES' : 'NO',
      a.personId ?? '',
    ])),
  ];
  const csv = rows.map(r =>
    r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  triggerDownload(new Blob([csv], { type: 'text/csv' }), `attendance_${isoDate()}.csv`);
  toast('CSV exported.');
});

el('resetBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL rooms, people, and sessions? This is permanent.')) return;
  if (!confirm('Last chance — are you sure?')) return;
  await DB.reset();
  S.people = []; S.sessions = [];
  await updateMeta();
  renderRoomsList(); renderRoomSelect(); renderPeople(); renderReports();
  toast('All data cleared.');
  setStatus('Database reset.', 'ok');
});

/* =========================================================
   SESSION DETAIL MODAL
========================================================= */
async function openSessionModal(session) {
  el('sessionModalTitle').textContent = `SESSION — ${formatDate(session.date)}`;

  const people = await DB.getPeople();

  let imgHtml = '';
  if (session.imageBlob) {
    const url = URL.createObjectURL(session.imageBlob);
    imgHtml = `<img class="session-img" src="${url}" alt="Attendance photo" />`;
  } else {
    imgHtml = `<div style="background:var(--bg-3);border-radius:var(--r);aspect-ratio:4/3;
      display:flex;align-items:center;justify-content:center;color:var(--text-low)">
      NO IMAGE</div>`;
  }

  const rows = session.attendees.map(a => {
    const person   = a.personId ? people.find(p => p.id === a.personId) : null;
    const thumbUrl = person?.thumbBlob ? URL.createObjectURL(person.thumbBlob) : null;
    const chair    = a.chairIndex !== null ? `Seat ${a.chairIndex + 1}` : 'No seat';
    return `<div class="attendee${a.personId ? '' : ' unk'}">
      ${thumbUrl
        ? `<img src="${thumbUrl}" alt="${escHtml(a.name)}" />`
        : `<div style="width:36px;height:36px;border-radius:var(--r);background:var(--bg-3);
            display:flex;align-items:center;justify-content:center;color:var(--text-low)">?</div>`
      }
      <div class="info">
        <b>${escHtml(a.name)}</b>
        <small>${escHtml(chair)}${a.isNew ? ' · NEW' : ''}</small>
      </div>
      <span class="badge ${a.personId ? 'ok' : 'new'}">${a.personId ? 'KNOWN' : 'UNK'}</span>
    </div>`;
  }).join('');

  el('sessionDetail').innerHTML = `
    <div>${imgHtml}</div>
    <div>
      <div class="card">
        <div class="card-head"><h3>DETAILS</h3></div>
        <div class="card-body">
          <div class="kv"><span>Room</span><strong>${escHtml(session.roomName)}</strong></div>
          <div class="kv"><span>Date</span><strong style="font-size:11px">${formatDate(session.date)}</strong></div>
          <div class="kv"><span>Present</span><strong style="color:var(--accent)">${session.presentCount}</strong></div>
          <div class="kv"><span>Total seats</span><strong>${session.seatCount || '—'}</strong></div>
        </div>
      </div>
      <div style="margin-top:14px">
        <div style="font-size:10px;letter-spacing:.16em;color:var(--text-low);margin-bottom:8px">ATTENDEES</div>
        <div class="attendees">${rows}</div>
      </div>
    </div>`;

  el('sessionModal').classList.remove('hidden');
}

el('sessionModalClose').addEventListener('click', () => el('sessionModal').classList.add('hidden'));

// Close modals on backdrop click
[el('identifyModal'), el('sessionModal')].forEach(modal => {
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
});

/* =========================================================
   MISC UTILS
========================================================= */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

/* =========================================================
   GO
========================================================= */
boot();
