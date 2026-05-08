/* =========================================================
   app.js — ATTENDANCE.SYS main controller
   Wires UI ↔ DB ↔ ML.
========================================================= */

const App = (() => {

  // ---------------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------------
  const state = {
    activeTab: 'setup',
    rooms: [], people: [], sessions: [],

    // Setup
    setup: {
      image: null,         // HTMLImageElement
      imageBlob: null,
      chairs: [],          // [{ x, y }] in image-pixel coordinates
      editingRoomId: null, // when editing existing room
    },

    // Attendance
    att: {
      roomId: null,
      room: null,
      image: null,
      imageBlob: null,
      faces: [],           // [{ box, descriptor, ... }] from ML
      faceCrops: [],       // Blob per face
      attendees: [],       // [{ faceIdx, personId, name, isNew, chairIdx }]
      pending: false,      // results awaiting "Save"
    },
  };

  // ---------------------------------------------------------------------------
  // BOOT
  // ---------------------------------------------------------------------------
  async function init() {
    // hide unused experimental button
    document.getElementById('autoDetectBtn').style.display = 'none';

    bindGlobalEvents();

    bootStatus('OPENING DATABASE…');
    bootLog('> Opening IndexedDB…');
    try { await DB.open(); }
    catch (err) { return bootFail('IndexedDB unavailable. Browsing in private mode?'); }
    bootLog('> Database ready.');
    bootProgress(15);

    bootStatus('LOADING VISION MODELS…');
    try {
      await ML.loadModels((msg, pct) => {
        bootStatus(msg.toUpperCase());
        bootLog('> ' + msg);
        if (pct) bootProgress(15 + pct * 0.85);
      });
    } catch (err) {
      return bootFail(err.message);
    }
    bootProgress(100);
    bootLog('> All systems online.');

    setTimeout(hideBoot, 450);

    await refreshAll();
    setStatus('Ready.', 'ok');
    setModelStatus('MODELS: loaded');
  }

  // ---------------------------------------------------------------------------
  // GLOBAL EVENTS
  // ---------------------------------------------------------------------------
  function bindGlobalEvents() {
    // Tabs
    document.getElementById('tabs').addEventListener('click', e => {
      const t = e.target.closest('.tab');
      if (!t) return;
      switchTab(t.dataset.tab);
    });

    // Setup
    document.getElementById('setupFile').addEventListener('change', onSetupFile);
    document.getElementById('setupCanvas').addEventListener('click', onSetupCanvasClick);
    document.getElementById('clearChairsBtn').addEventListener('click', clearChairs);
    document.getElementById('saveRoomBtn').addEventListener('click', saveRoom);
    document.getElementById('roomName').addEventListener('input', updateSaveBtn);

    // Attendance
    document.getElementById('attRoomSelect').addEventListener('change', onAttRoomChange);
    document.getElementById('attFile').addEventListener('change', onAttFile);
    document.getElementById('saveSessionBtn').addEventListener('click', saveSession);
    document.getElementById('discardSessionBtn').addEventListener('click', discardSession);

    // Modal
    document.getElementById('modalCloseBtn').addEventListener('click', closeIdentifyModal);
    document.getElementById('modalCancelBtn').addEventListener('click', closeIdentifyModal);
    document.getElementById('modalConfirmBtn').addEventListener('click', confirmIdentify);
    document.getElementById('sessionModalClose').addEventListener('click', closeSessionModal);

    // Reports
    document.getElementById('exportJsonBtn').addEventListener('click', exportJson);
    document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
    document.getElementById('resetBtn').addEventListener('click', resetAll);

    // People search
    document.getElementById('peopleSearch').addEventListener('input', renderPeople);

    // Window resize → redraw active canvas
    window.addEventListener('resize', () => {
      if (state.setup.image) drawSetupCanvas();
      if (state.att.image)   drawAttCanvas();
    });
  }

  // ---------------------------------------------------------------------------
  // TABS
  // ---------------------------------------------------------------------------
  function switchTab(name) {
    state.activeTab = name;
    document.querySelectorAll('.tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-content').forEach(s =>
      s.classList.toggle('active', s.id === name));
    if (name === 'people')  renderPeople();
    if (name === 'reports') renderReports();
    if (name === 'attendance') renderAttRoomSelect();
  }

  // ---------------------------------------------------------------------------
  // REFRESH
  // ---------------------------------------------------------------------------
  async function refreshAll() {
    const [rooms, people, sessions] = await Promise.all([
      DB.getRooms(), DB.getPeople(), DB.getSessions(),
    ]);
    state.rooms    = rooms;
    state.people   = people;
    state.sessions = sessions;
    document.getElementById('metaPeople').textContent   = people.length;
    document.getElementById('metaSessions').textContent = sessions.length;
    renderRoomsList();
    renderAttRoomSelect();
  }

  // ===========================================================================
  // SETUP
  // ===========================================================================
  async function onSetupFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setStatus('Loading image…');
    try {
      const img = await fileToImage(file);
      state.setup.image = img;
      state.setup.imageBlob = file;
      state.setup.chairs = [];
      state.setup.editingRoomId = null;
      document.getElementById('setupEmpty').classList.add('hidden');
      document.getElementById('setupCanvas').classList.remove('hidden');
      document.getElementById('imgDims').textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
      drawSetupCanvas();
      updateSeatCount();
      updateSaveBtn();
      setStatus('Click on chairs to mark seats.', 'ok');
    } catch (err) {
      toast('Failed to load image: ' + err.message, true);
    }
    e.target.value = '';
  }

  function drawSetupCanvas() {
    const c = document.getElementById('setupCanvas');
    const img = state.setup.image;
    if (!img) return;

    c.width  = img.naturalWidth;
    c.height = img.naturalHeight;
    fitCanvas(c);

    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // Markers
    const r = Math.max(18, Math.min(c.width, c.height) * 0.018);
    state.setup.chairs.forEach((ch, i) => drawSeatMarker(ctx, ch.x, ch.y, i + 1, r));
  }

  function fitCanvas(c) {
    // Constrain canvas to wrap height
    const wrap = c.parentElement;
    const maxH = Math.min(window.innerHeight * 0.7, 800);
    const ratio = c.width / c.height;
    let displayH = Math.min(maxH, wrap.clientWidth / ratio);
    let displayW = displayH * ratio;
    if (displayW > wrap.clientWidth) {
      displayW = wrap.clientWidth - 4;
      displayH = displayW / ratio;
    }
    c.style.width  = displayW + 'px';
    c.style.height = displayH + 'px';
  }

  function drawSeatMarker(ctx, x, y, n, r) {
    ctx.save();
    // outer ring
    ctx.lineWidth = Math.max(2, r * 0.18);
    ctx.strokeStyle = '#c8ff00';
    ctx.fillStyle = 'rgba(200, 255, 0, 0.2)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // crosshair
    ctx.strokeStyle = '#0a0d0a';
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath();
    ctx.moveTo(x - r * 0.4, y); ctx.lineTo(x + r * 0.4, y);
    ctx.moveTo(x, y - r * 0.4); ctx.lineTo(x, y + r * 0.4);
    ctx.stroke();
    // number
    ctx.fillStyle = '#c8ff00';
    ctx.fillRect(x + r * 0.6, y - r, r * 1.4, r * 0.9);
    ctx.fillStyle = '#0a0d0a';
    ctx.font = `700 ${r * 0.7}px JetBrains Mono, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), x + r * 1.3, y - r * 0.55);
    ctx.restore();
  }

  function onSetupCanvasClick(e) {
    const c = e.currentTarget;
    const rect = c.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (c.width  / rect.width);
    const y = (e.clientY - rect.top)  * (c.height / rect.height);

    // remove if click is near existing marker
    const r = Math.max(28, Math.min(c.width, c.height) * 0.025);
    const hit = state.setup.chairs.findIndex(ch =>
      Math.hypot(ch.x - x, ch.y - y) < r);
    if (hit >= 0) {
      state.setup.chairs.splice(hit, 1);
    } else {
      state.setup.chairs.push({ x, y });
    }
    drawSetupCanvas();
    updateSeatCount();
    updateSaveBtn();
  }

  function clearChairs() {
    if (state.setup.chairs.length === 0) return;
    if (!confirm('Remove all seat markers?')) return;
    state.setup.chairs = [];
    drawSetupCanvas();
    updateSeatCount();
    updateSaveBtn();
  }

  function updateSeatCount() {
    document.getElementById('seatCount').textContent = state.setup.chairs.length;
    document.getElementById('clearChairsBtn').disabled = state.setup.chairs.length === 0;
  }

  function updateSaveBtn() {
    const ok = state.setup.image
      && state.setup.chairs.length > 0
      && document.getElementById('roomName').value.trim().length > 0;
    document.getElementById('saveRoomBtn').disabled = !ok;
  }

  async function saveRoom() {
    const name = document.getElementById('roomName').value.trim();
    if (!name || !state.setup.image || state.setup.chairs.length === 0) return;

    const room = {
      name,
      imageBlob: state.setup.imageBlob,
      chairs: state.setup.chairs.slice(),
      imgWidth:  state.setup.image.naturalWidth,
      imgHeight: state.setup.image.naturalHeight,
      createdAt: new Date().toISOString(),
    };

    if (state.setup.editingRoomId) {
      room.id = state.setup.editingRoomId;
      await DB.updateRoom(room);
      toast('Room updated.');
    } else {
      await DB.addRoom(room);
      toast(`Room "${name}" saved.`);
    }

    // reset setup
    state.setup = { image: null, imageBlob: null, chairs: [], editingRoomId: null };
    document.getElementById('roomName').value = '';
    document.getElementById('setupCanvas').classList.add('hidden');
    document.getElementById('setupEmpty').classList.remove('hidden');
    document.getElementById('imgDims').textContent = '—';
    updateSeatCount();
    updateSaveBtn();
    await refreshAll();
  }

  async function renderRoomsList() {
    const root = document.getElementById('roomsList');
    if (state.rooms.length === 0) {
      root.innerHTML = '<p class="muted">No rooms saved yet.</p>';
      return;
    }
    root.innerHTML = '';
    for (const r of state.rooms) {
      const div = document.createElement('div');
      div.className = 'room-item';
      div.innerHTML = `
        <div>
          <div class="room-item-name">${escapeHtml(r.name)}</div>
          <div class="room-item-meta">${r.chairs.length} seats · ${formatDate(r.createdAt)}</div>
        </div>
        <div>
          <button class="x" data-edit="${r.id}" title="Edit">✎</button>
          <button class="x" data-del="${r.id}" title="Delete">×</button>
        </div>`;
      div.querySelector('[data-edit]').addEventListener('click', () => editRoom(r.id));
      div.querySelector('[data-del]').addEventListener('click', () => removeRoom(r.id));
      root.appendChild(div);
    }
  }

  async function editRoom(id) {
    const r = await DB.getRoom(id);
    if (!r) return;
    const img = await blobToImage(r.imageBlob);
    state.setup = {
      image: img,
      imageBlob: r.imageBlob,
      chairs: r.chairs.slice(),
      editingRoomId: r.id,
    };
    document.getElementById('roomName').value = r.name;
    document.getElementById('setupEmpty').classList.add('hidden');
    document.getElementById('setupCanvas').classList.remove('hidden');
    document.getElementById('imgDims').textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
    drawSetupCanvas();
    updateSeatCount();
    updateSaveBtn();
    switchTab('setup');
  }

  async function removeRoom(id) {
    if (!confirm('Delete this room layout? Past sessions remain unaffected.')) return;
    await DB.deleteRoom(id);
    toast('Room deleted.');
    await refreshAll();
  }

  // ===========================================================================
  // ATTENDANCE
  // ===========================================================================
  function renderAttRoomSelect() {
    const sel = document.getElementById('attRoomSelect');
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Select a room —</option>' +
      state.rooms.map(r => `<option value="${r.id}">${escapeHtml(r.name)} · ${r.chairs.length} seats</option>`).join('');
    if (cur) sel.value = cur;
  }

  async function onAttRoomChange(e) {
    const id = parseInt(e.target.value, 10);
    if (!id) { state.att.roomId = null; state.att.room = null; return; }
    state.att.roomId = id;
    state.att.room = await DB.getRoom(id);
  }

  async function onAttFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    if (!state.att.roomId) {
      toast('Select a room first.', true);
      return;
    }

    setStatus('Detecting faces…', 'busy');
    try {
      const img = await fileToImage(file);
      state.att.image = img;
      state.att.imageBlob = file;

      document.getElementById('attEmpty').classList.add('hidden');
      const c = document.getElementById('attCanvas');
      c.classList.remove('hidden');

      // initial draw (image only)
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      fitCanvas(c);
      c.getContext('2d').drawImage(img, 0, 0);

      // detect
      const faces = await ML.detectFaces(img);
      state.att.faces = faces;

      // crop face thumbnails
      state.att.faceCrops = await Promise.all(
        faces.map(f => ML.cropFace(img, f.box))
      );

      // chair assignments
      const chairAssignments = ML.assignFacesToChairs(faces, state.att.room.chairs);

      // match against roster
      const attendees = faces.map((f, i) => {
        const m = ML.matchFace(f.descriptor, state.people);
        return {
          faceIdx: i,
          chairIdx: chairAssignments[i],   // index into room.chairs (or null)
          personId: m ? m.personId : null,
          name: m ? m.name : null,
          isNew: !m,
          distance: m ? m.distance : null,
        };
      });

      state.att.attendees = attendees;
      state.att.pending = true;

      drawAttCanvas();
      updateAttResults();
      renderAttendeesList();

      const unknowns = attendees.filter(a => a.isNew);
      if (unknowns.length > 0) {
        openIdentifyModal(unknowns);
      }

      document.getElementById('saveSessionBtn').disabled = false;
      document.getElementById('discardSessionBtn').disabled = false;
      setStatus(`Detected ${faces.length} face${faces.length === 1 ? '' : 's'}.`, 'ok');
    } catch (err) {
      console.error(err);
      toast('Detection failed: ' + err.message, true);
      setStatus('Detection failed.', 'error');
    }
  }

  function drawAttCanvas() {
    const c = document.getElementById('attCanvas');
    const img = state.att.image;
    if (!img) return;
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    fitCanvas(c);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // chair markers (faded)
    const room = state.att.room;
    const r = Math.max(18, Math.min(c.width, c.height) * 0.018);
    if (room) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      room.chairs.forEach((ch, i) => drawSeatMarker(ctx, ch.x, ch.y, i + 1, r));
      ctx.restore();
    }

    // face boxes
    state.att.attendees.forEach(att => {
      const face = state.att.faces[att.faceIdx];
      const { x, y, width, height } = face.box;
      const isUnk = att.isNew;
      ctx.lineWidth = Math.max(2, c.width * 0.0025);
      ctx.strokeStyle = isUnk ? '#ffb547' : '#c8ff00';
      ctx.fillStyle   = isUnk ? '#ffb547' : '#c8ff00';
      ctx.strokeRect(x, y, width, height);
      // label
      const label = att.name || (isUnk ? 'NEW?' : '?');
      const fontSize = Math.max(14, c.width * 0.018);
      ctx.font = `700 ${fontSize}px JetBrains Mono, monospace`;
      const padding = fontSize * 0.4;
      const tw = ctx.measureText(label).width + padding * 2;
      ctx.fillRect(x, y - fontSize - padding, tw, fontSize + padding);
      ctx.fillStyle = '#0a0d0a';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + padding, y - (fontSize + padding) / 2);
    });
  }

  function updateAttResults() {
    const a = state.att.attendees;
    document.getElementById('facesCount').textContent = state.att.faces.length;
    document.getElementById('recCount').textContent   = a.filter(x => !x.isNew && x.personId).length;
    document.getElementById('unkCount').textContent   = a.filter(x => x.isNew).length;
    const seats = state.att.room ? state.att.room.chairs.length : 0;
    const filled = a.filter(x => x.chairIdx !== null && x.chairIdx !== undefined).length;
    document.getElementById('seatsFilled').textContent = `${filled} / ${seats}`;
  }

  function renderAttendeesList() {
    const root = document.getElementById('attendeesList');
    document.getElementById('attendeesCard').hidden = state.att.attendees.length === 0;
    if (state.att.attendees.length === 0) { root.innerHTML = ''; return; }
    root.innerHTML = '<div class="attendees"></div>';
    const list = root.querySelector('.attendees');
    state.att.attendees
      .slice()
      .sort((a, b) => (a.chairIdx ?? 999) - (b.chairIdx ?? 999))
      .forEach(att => {
        const blob = state.att.faceCrops[att.faceIdx];
        const url = URL.createObjectURL(blob);
        const seatLabel = (att.chairIdx !== null && att.chairIdx !== undefined)
          ? `Seat ${att.chairIdx + 1}` : 'Off-seat';
        const div = document.createElement('div');
        div.className = 'attendee' + (att.isNew ? ' unk' : '');
        div.innerHTML = `
          <img src="${url}" alt="" />
          <div class="info">
            <b>${escapeHtml(att.name || 'Unknown')}</b>
            <small>${seatLabel}${att.distance ? ' · d=' + att.distance.toFixed(2) : ''}</small>
          </div>
          <span class="badge ${att.isNew ? 'new' : 'ok'}">${att.isNew ? 'NEW' : 'KNOWN'}</span>`;
        list.appendChild(div);
      });
  }

  // ----- IDENTIFY MODAL -----
  function openIdentifyModal(unknowns) {
    const root = document.getElementById('identifyList');
    root.innerHTML = '';
    unknowns.forEach(att => {
      const blob = state.att.faceCrops[att.faceIdx];
      const url = URL.createObjectURL(blob);
      const div = document.createElement('div');
      div.className = 'identify-item';
      div.dataset.faceIdx = att.faceIdx;
      div.innerHTML = `
        <img src="${url}" alt="" />
        <div class="controls">
          <div class="row">
            <select class="select existing-sel">
              <option value="">— New person —</option>
              ${state.people.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
              <option value="__skip">Skip (anonymous)</option>
            </select>
          </div>
          <div class="row">
            <input type="text" class="new-name" placeholder="Or type a new name…" />
          </div>
        </div>`;
      root.appendChild(div);
    });
    document.getElementById('identifyModal').classList.remove('hidden');
  }

  async function confirmIdentify() {
    const items = document.querySelectorAll('#identifyList .identify-item');
    for (const item of items) {
      const faceIdx = parseInt(item.dataset.faceIdx, 10);
      const sel = item.querySelector('.existing-sel').value;
      const newName = item.querySelector('.new-name').value.trim();
      const att = state.att.attendees.find(a => a.faceIdx === faceIdx);
      if (!att) continue;

      if (sel === '__skip' && !newName) {
        att.name = 'Anonymous';
        att.personId = null;
        att.isNew = false;
        continue;
      }
      if (sel && sel !== '__skip') {
        // Match to existing person — add this descriptor as a new training sample.
        // (encounters / lastSeen will be bumped when the session is saved.)
        const personId = parseInt(sel, 10);
        const person = state.people.find(p => p.id === personId);
        if (person) {
          person.descriptors = (person.descriptors || []).concat([state.att.faces[faceIdx].descriptor]);
          await DB.updatePerson(person);
          att.personId = person.id;
          att.name = person.name;
          att.isNew = false;
        }
        continue;
      }
      if (newName) {
        const blob = state.att.faceCrops[faceIdx];
        const desc = state.att.faces[faceIdx].descriptor;
        const personId = await DB.addPerson({
          name: newName,
          descriptors: [desc],
          thumbBlob: blob,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          encounters: 0,
        });
        att.personId = personId;
        att.name = newName;
        att.isNew = false;
      }
    }
    closeIdentifyModal();
    await refreshAll();
    drawAttCanvas();
    updateAttResults();
    renderAttendeesList();
    toast('Identifications saved.');
  }

  function closeIdentifyModal() {
    document.getElementById('identifyModal').classList.add('hidden');
  }

  async function saveSession() {
    if (!state.att.room || !state.att.imageBlob) return;

    const session = {
      roomId: state.att.roomId,
      roomName: state.att.room.name,
      date: new Date().toISOString(),
      imageBlob: state.att.imageBlob,
      attendees: state.att.attendees.map(a => ({
        personId: a.personId,
        name: a.name || 'Anonymous',
        isAnonymous: !a.personId,
        chairIdx: a.chairIdx,
        box: state.att.faces[a.faceIdx].box,
      })),
      faceCount: state.att.faces.length,
      seatCount: state.att.room.chairs.length,
    };
    await DB.addSession(session);

    // bump people lastSeen
    const presentIds = new Set(session.attendees.map(a => a.personId).filter(Boolean));
    for (const pid of presentIds) {
      const p = state.people.find(x => x.id === pid);
      if (p) {
        p.lastSeen = session.date;
        p.encounters = (p.encounters || 0) + 1;
        await DB.updatePerson(p);
      }
    }

    discardSession();
    await refreshAll();
    toast('Attendance saved.');
    switchTab('reports');
  }

  function discardSession() {
    state.att = {
      roomId: state.att.roomId, room: state.att.room,
      image: null, imageBlob: null, faces: [], faceCrops: [], attendees: [], pending: false,
    };
    document.getElementById('attCanvas').classList.add('hidden');
    document.getElementById('attEmpty').classList.remove('hidden');
    document.getElementById('attendeesCard').hidden = true;
    document.getElementById('facesCount').textContent = '—';
    document.getElementById('recCount').textContent = '—';
    document.getElementById('unkCount').textContent = '—';
    document.getElementById('seatsFilled').textContent = '—';
    document.getElementById('saveSessionBtn').disabled = true;
    document.getElementById('discardSessionBtn').disabled = true;
  }

  // ===========================================================================
  // PEOPLE
  // ===========================================================================
  function renderPeople() {
    const grid = document.getElementById('peopleGrid');
    const term = (document.getElementById('peopleSearch').value || '').toLowerCase();
    const filtered = state.people.filter(p => p.name.toLowerCase().includes(term));

    if (filtered.length === 0) {
      grid.innerHTML = `<div class="empty-block">
        <h3>${state.people.length === 0 ? 'NO PEOPLE YET' : 'NO MATCHES'}</h3>
        <p>${state.people.length === 0
            ? 'The roster fills automatically as you take attendance and identify new faces.'
            : 'Try a different search term.'}</p>
      </div>`;
      return;
    }
    grid.innerHTML = '';
    filtered.forEach(p => {
      const card = document.createElement('div');
      card.className = 'person-card';
      const url = p.thumbBlob ? URL.createObjectURL(p.thumbBlob) : '';
      card.innerHTML = `
        <img class="person-thumb" src="${url}" alt="${escapeHtml(p.name)}"/>
        <div class="person-meta">
          <div class="person-name">${escapeHtml(p.name)}</div>
          <div class="person-stats">
            ${p.encounters || 1}× SEEN · ${(p.descriptors || []).length} SAMPLES
          </div>
        </div>
        <div class="person-actions">
          <button data-act="rename">RENAME</button>
          <button class="del" data-act="del">DELETE</button>
        </div>`;
      card.querySelector('[data-act="rename"]').addEventListener('click', () => renamePerson(p.id));
      card.querySelector('[data-act="del"]').addEventListener('click', () => deletePerson(p.id));
      grid.appendChild(card);
    });
  }

  async function renamePerson(id) {
    const p = state.people.find(x => x.id === id);
    if (!p) return;
    const next = prompt('Rename person:', p.name);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    p.name = trimmed;
    await DB.updatePerson(p);
    await refreshAll();
    renderPeople();
    toast('Renamed.');
  }

  async function deletePerson(id) {
    const p = state.people.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`Delete "${p.name}"? Past attendance entries become anonymous.`)) return;
    await DB.deletePerson(id);
    await refreshAll();
    renderPeople();
    toast('Deleted.');
  }

  // ===========================================================================
  // REPORTS
  // ===========================================================================
  function renderReports() {
    const sums = document.getElementById('reportsSummary');
    const sessions = state.sessions.slice().sort((a, b) => b.date.localeCompare(a.date));

    const totalFaces = sessions.reduce((s, x) => s + (x.faceCount || 0), 0);
    const uniqPeople = new Set();
    sessions.forEach(s => s.attendees.forEach(a => a.personId && uniqPeople.add(a.personId)));
    const lastDate = sessions[0]?.date;

    sums.innerHTML = `
      <div class="summary-box"><div class="v">${sessions.length}</div><div class="k">SESSIONS</div></div>
      <div class="summary-box"><div class="v">${totalFaces}</div><div class="k">TOTAL ATTENDANCE</div></div>
      <div class="summary-box"><div class="v">${uniqPeople.size}</div><div class="k">UNIQUE PEOPLE</div></div>
      <div class="summary-box"><div class="v">${lastDate ? formatDate(lastDate) : '—'}</div><div class="k">MOST RECENT</div></div>`;

    const tbody = document.getElementById('sessionsTbody');
    if (sessions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted center">No sessions recorded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    sessions.forEach(s => {
      const tr = document.createElement('tr');
      const pills = s.attendees.map(a =>
        `<span class="att-pill ${a.isAnonymous ? 'unk' : ''}">${escapeHtml(a.name)}</span>`
      ).join('');
      tr.innerHTML = `
        <td>${formatDate(s.date)}</td>
        <td>${escapeHtml(s.roomName || '—')}</td>
        <td><b>${s.faceCount}</b> / ${s.seatCount}</td>
        <td>${s.seatCount}</td>
        <td>${pills || '<span class="muted">—</span>'}</td>
        <td>
          <button class="btn ghost" data-view="${s.id}">VIEW</button>
          <button class="btn ghost" data-del="${s.id}">DEL</button>
        </td>`;
      tr.querySelector('[data-view]').addEventListener('click', () => showSessionDetail(s.id));
      tr.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm('Delete this session?')) return;
        await DB.deleteSession(s.id);
        await refreshAll();
        renderReports();
        toast('Session deleted.');
      });
      tbody.appendChild(tr);
    });
  }

  async function showSessionDetail(id) {
    const s = await DB.getSession(id);
    if (!s) return;
    document.getElementById('sessionModalTitle').textContent =
      `${s.roomName} · ${formatDate(s.date)}`;
    const root = document.getElementById('sessionDetail');
    const url = URL.createObjectURL(s.imageBlob);

    // build canvas with face boxes
    const img = await blobToImage(s.imageBlob);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.borderRadius = '4px';
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    s.attendees.forEach(a => {
      if (!a.box) return;
      ctx.lineWidth = Math.max(2, canvas.width * 0.0025);
      ctx.strokeStyle = a.isAnonymous ? '#ffb547' : '#c8ff00';
      ctx.fillStyle   = a.isAnonymous ? '#ffb547' : '#c8ff00';
      ctx.strokeRect(a.box.x, a.box.y, a.box.width, a.box.height);
      const fontSize = Math.max(14, canvas.width * 0.018);
      ctx.font = `700 ${fontSize}px JetBrains Mono, monospace`;
      const tw = ctx.measureText(a.name).width + fontSize * 0.8;
      ctx.fillRect(a.box.x, a.box.y - fontSize * 1.4, tw, fontSize * 1.4);
      ctx.fillStyle = '#0a0d0a';
      ctx.textBaseline = 'middle';
      ctx.fillText(a.name, a.box.x + fontSize * 0.4, a.box.y - fontSize * 0.7);
    });

    root.innerHTML = '';
    const left = document.createElement('div');
    left.appendChild(canvas);
    root.appendChild(left);

    const right = document.createElement('div');
    right.innerHTML = `
      <div class="kv"><span>Room</span><strong>${escapeHtml(s.roomName)}</strong></div>
      <div class="kv"><span>Date</span><strong>${formatDate(s.date)}</strong></div>
      <div class="kv"><span>Present</span><strong>${s.faceCount} / ${s.seatCount}</strong></div>
      <h3 style="margin: 18px 0 10px;">ATTENDEES</h3>
      <div class="attendees">
        ${s.attendees.map(a => `
          <div class="attendee${a.isAnonymous ? ' unk' : ''}">
            <div class="info">
              <b>${escapeHtml(a.name)}</b>
              <small>${a.chairIdx !== null && a.chairIdx !== undefined ? 'Seat ' + (a.chairIdx + 1) : 'Off-seat'}</small>
            </div>
            <span class="badge ${a.isAnonymous ? 'new' : 'ok'}">${a.isAnonymous ? 'ANON' : 'ID'}</span>
          </div>`).join('')}
      </div>`;
    root.appendChild(right);

    document.getElementById('sessionModal').classList.remove('hidden');
  }

  function closeSessionModal() {
    document.getElementById('sessionModal').classList.add('hidden');
  }

  // ----- EXPORTS -----
  async function exportJson() {
    setStatus('Exporting…', 'busy');
    try {
      const data = await DB.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      downloadBlob(blob, `attendance-export-${todayStamp()}.json`);
      toast('Exported JSON.');
      setStatus('Ready.', 'ok');
    } catch (err) {
      toast('Export failed: ' + err.message, true);
      setStatus('Error.', 'error');
    }
  }

  async function exportCsv() {
    const rows = [['session_id', 'date', 'room', 'person_id', 'person_name', 'is_anonymous', 'seat']];
    for (const s of state.sessions) {
      for (const a of s.attendees) {
        rows.push([
          s.id, s.date, s.roomName,
          a.personId || '',
          a.name,
          a.isAnonymous ? 'true' : 'false',
          a.chairIdx !== null && a.chairIdx !== undefined ? a.chairIdx + 1 : '',
        ]);
      }
    }
    const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
    downloadBlob(new Blob([csv], { type: 'text/csv' }), `attendance-${todayStamp()}.csv`);
    toast('Exported CSV.');
  }

  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  async function resetAll() {
    const text = prompt('Type RESET to wipe all rooms, people, and sessions. This cannot be undone.');
    if (text !== 'RESET') return;
    await DB.reset();
    await refreshAll();
    renderReports();
    renderPeople();
    discardSession();
    toast('All data wiped.');
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================
  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not decode image'));
      img.src = url;
    });
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not decode image'));
      img.src = url;
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function todayStamp() {
    const d = new Date();
    return d.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function toast(msg, isError = false) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function setStatus(msg, level) {
    document.getElementById('statusText').textContent = msg;
    const dot = document.getElementById('statusDot');
    dot.className = 'stat-dot' + (level ? ' ' + level : '');
  }

  function setModelStatus(msg) {
    document.getElementById('statusModel').textContent = msg;
  }

  // ----- BOOT UI -----
  function bootStatus(msg) { document.getElementById('bootStatus').textContent = msg; }
  function bootProgress(pct) { document.getElementById('bootProgress').style.width = pct + '%'; }
  function bootLog(msg) {
    const log = document.getElementById('bootLog');
    log.textContent += msg + '\n';
    log.scrollTop = log.scrollHeight;
  }
  function hideBoot() {
    const b = document.getElementById('boot');
    b.classList.add('done');
    setTimeout(() => b.style.display = 'none', 600);
  }
  function bootFail(msg) {
    bootStatus('BOOT ERROR');
    bootLog('> ERROR: ' + msg);
    setStatus('Boot failed — ' + msg, 'error');
    setModelStatus('MODELS: error');
    document.getElementById('bootHint').textContent =
      'Reload to retry. If this persists, check your network or browser console.';
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
