/* =========================================================
   app.js — ATTENDANCE.SYS main controller (simplified)

   No rooms. No chair points. Just: upload a photo → detect every
   face → match against the roster → identify unknowns → save.
========================================================= */

const App = (() => {

  // ---------------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------------
  const state = {
    activeTab: 'attendance',
    people: [], sessions: [],

    att: {
      image:     null,
      imageBlob: null,
      faces:     [],
      faceCrops: [],         // array of data-URL strings
      attendees: [],
      pending:   false,
    },
  };

  // ---------------------------------------------------------------------------
  // BOOT
  // ---------------------------------------------------------------------------
  async function init() {
    bindGlobalEvents();
    bindSignInEvents();

    bootStatus('CONNECTING TO FIREBASE…');
    try {
      Auth.init();
    } catch (err) {
      return bootFail(err.message);
    }
    bootLog('> Firebase initialized.');
    bootProgress(8);

    bootStatus('CHECKING AUTH STATE…');
    const user = await Auth.waitForFirstAuthState();
    if (!user) {
      showSignInScreen();
      return;
    }
    afterSignedIn(user);
  }

  async function afterSignedIn(user) {
    showLoadingScreen();
    bootLog('> Signed in as ' + user.email);
    bootProgress(15);
    updateUserBadge(user);

    bootStatus('LOADING VISION MODELS…');
    try {
      await ML.loadModels((msg, pct) => {
        bootStatus(msg.toUpperCase());
        bootLog('> ' + msg);
        if (pct) bootProgress(15 + pct * 0.7);
      });
    } catch (err) {
      return bootFail(err.message);
    }
    bootProgress(85);

    bootStatus('LOADING DATA…');
    try {
      await refreshAll();
    } catch (err) {
      return bootFail('Could not load data: ' + err.message +
        ' — verify your Firestore rules allow this user to read /users/{uid}.');
    }
    bootProgress(100);
    bootLog('> All systems online.');

    setTimeout(hideBoot, 450);
    setStatus('Ready. Upload a photo to take attendance.', 'ok');
    setModelStatus('MODELS: loaded');

    Auth.onChange(u => { if (!u) location.reload(); });
  }

  function showSignInScreen() {
    document.getElementById('bootLoading').classList.add('hidden');
    document.getElementById('bootSignIn').classList.remove('hidden');
    document.getElementById('boot').classList.remove('done');
    document.getElementById('boot').style.display = '';
    setStatus('Not signed in.', 'error');
    setModelStatus('MODELS: idle');
  }
  function showLoadingScreen() {
    document.getElementById('bootSignIn').classList.add('hidden');
    document.getElementById('bootLoading').classList.remove('hidden');
  }

  function bindSignInEvents() {
    document.getElementById('googleSignInBtn').addEventListener('click', async () => {
      const errEl = document.getElementById('signInError');
      errEl.classList.add('hidden');
      try {
        const u = await Auth.signInGoogle();
        if (u) afterSignedIn(u);
      } catch (err) {
        errEl.textContent = err.message || 'Sign-in failed.';
        errEl.classList.remove('hidden');
      }
    });
    document.getElementById('signOutBtn').addEventListener('click', async () => {
      if (!confirm('Sign out?')) return;
      await Auth.signOut();
    });
  }

  function updateUserBadge(user) {
    const badge = document.getElementById('userBadge');
    if (!user) { badge.hidden = true; return; }
    badge.hidden = false;
    document.getElementById('userEmail').textContent = user.email || user.displayName || '';
    const avatar = document.getElementById('userAvatar');
    if (user.photoURL) { avatar.src = user.photoURL; avatar.style.display = ''; }
    else avatar.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // GLOBAL EVENTS
  // ---------------------------------------------------------------------------
  function bindGlobalEvents() {
    document.getElementById('tabs').addEventListener('click', e => {
      const t = e.target.closest('.tab');
      if (!t) return;
      switchTab(t.dataset.tab);
    });

    document.getElementById('attFile').addEventListener('change', onAttFile);
    document.getElementById('saveSessionBtn').addEventListener('click', saveSession);
    document.getElementById('reIdentifyBtn').addEventListener('click', reopenIdentify);
    document.getElementById('discardSessionBtn').addEventListener('click', discardSession);

    document.getElementById('modalCloseBtn').addEventListener('click', closeIdentifyModal);
    document.getElementById('modalCancelBtn').addEventListener('click', closeIdentifyModal);
    document.getElementById('modalConfirmBtn').addEventListener('click', confirmIdentify);
    document.getElementById('sessionModalClose').addEventListener('click', closeSessionModal);

    document.getElementById('exportJsonBtn').addEventListener('click', exportJson);
    document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
    document.getElementById('resetBtn').addEventListener('click', resetAll);

    document.getElementById('peopleSearch').addEventListener('input', renderPeople);

    // Drag and drop onto the canvas wrap
    const dropZone = document.getElementById('attCanvasWrap');
    ['dragenter', 'dragover'].forEach(ev => {
      dropZone.addEventListener(ev, e => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        dropZone.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      dropZone.addEventListener(ev, e => {
        e.preventDefault();
        if (ev === 'dragleave' && dropZone.contains(e.relatedTarget)) return;
        dropZone.classList.remove('drag-over');
      });
    });
    dropZone.addEventListener('drop', e => {
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) processAttFile(file);
    });

    window.addEventListener('resize', () => {
      if (state.att.image) drawAttCanvas();
    });
  }

  function switchTab(name) {
    state.activeTab = name;
    document.querySelectorAll('.tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-content').forEach(s =>
      s.classList.toggle('active', s.id === name));
    if (name === 'people')  renderPeople();
    if (name === 'reports') renderReports();
  }

  async function refreshAll() {
    const [people, sessions] = await Promise.all([
      DB.getPeople(), DB.getSessions(),
    ]);
    state.people   = people;
    state.sessions = sessions;
    document.getElementById('metaPeople').textContent   = people.length;
    document.getElementById('metaSessions').textContent = sessions.length;
  }

  // ===========================================================================
  // ATTENDANCE
  // ===========================================================================
  async function onAttFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await processAttFile(file);
  }

  async function processAttFile(file) {
    setStatus('Detecting faces…', 'busy');
    try {
      const img = await fileToImage(file);
      state.att.image = img;
      state.att.imageBlob = file;

      document.getElementById('attEmpty').classList.add('hidden');
      const c = document.getElementById('attCanvas');
      c.classList.remove('hidden');

      c.width  = img.naturalWidth;
      c.height = img.naturalHeight;
      fitCanvas(c);
      c.getContext('2d').drawImage(img, 0, 0);

      const faces = await ML.detectFaces(img);
      state.att.faces = faces;

      state.att.faceCrops = await Promise.all(
        faces.map(f => ML.cropFace(img, f.box))
      );

      const attendees = faces.map((f, i) => {
        const m = ML.matchFace(f.descriptor, state.people);
        return {
          faceIdx:   i,
          personId:  m ? m.personId : null,
          name:      m ? m.name : null,
          isNew:     !m,
          distance:  m ? m.distance : null,
        };
      });

      state.att.attendees = attendees;
      state.att.pending = true;

      drawAttCanvas();
      updateAttResults();
      renderAttendeesList();

      const unknowns = attendees.filter(a => a.isNew);
      if (unknowns.length > 0) openIdentifyModal(unknowns);

      document.getElementById('saveSessionBtn').disabled = false;
      document.getElementById('discardSessionBtn').disabled = false;
      updateReIdentifyBtn();

      const n = faces.length;
      if (n === 0) {
        setStatus('No faces detected. Try a clearer photo.', 'error');
      } else {
        setStatus(`Detected ${n} face${n === 1 ? '' : 's'}.`, 'ok');
      }
    } catch (err) {
      console.error(err);
      toast('Detection failed: ' + err.message, true);
      setStatus('Detection failed.', 'error');
    }
  }

  function fitCanvas(c) {
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

  function drawAttCanvas() {
    const c = document.getElementById('attCanvas');
    const img = state.att.image;
    if (!img) return;
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    fitCanvas(c);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);

    state.att.attendees.forEach(att => {
      const face = state.att.faces[att.faceIdx];
      const { x, y, width, height } = face.box;
      const isUnk = att.isNew;
      ctx.lineWidth = Math.max(2, c.width * 0.0025);
      ctx.strokeStyle = isUnk ? '#ffb547' : '#c8ff00';
      ctx.fillStyle   = isUnk ? '#ffb547' : '#c8ff00';
      ctx.strokeRect(x, y, width, height);
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
  }

  function updateReIdentifyBtn() {
    const unknowns = state.att.attendees.filter(a => a.isNew).length;
    const btn = document.getElementById('reIdentifyBtn');
    btn.hidden = unknowns === 0;
    btn.disabled = unknowns === 0;
    if (unknowns > 0) {
      btn.textContent = `IDENTIFY ${unknowns} UNKNOWN${unknowns === 1 ? '' : 'S'}`;
    }
  }

  function renderAttendeesList() {
    const root = document.getElementById('attendeesList');
    document.getElementById('attendeesCard').hidden = state.att.attendees.length === 0;
    if (state.att.attendees.length === 0) { root.innerHTML = ''; return; }
    root.innerHTML = '<div class="attendees"></div>';
    const list = root.querySelector('.attendees');

    // Group: knowns first (alphabetical), then unknowns
    const sorted = state.att.attendees.slice().sort((a, b) => {
      if (a.isNew !== b.isNew) return a.isNew ? 1 : -1;
      return (a.name || '').localeCompare(b.name || '');
    });

    sorted.forEach(att => {
      const url = state.att.faceCrops[att.faceIdx];
      const div = document.createElement('div');
      div.className = 'attendee' + (att.isNew ? ' unk' : '');
      div.innerHTML = `
        <img src="${url}" alt="" />
        <div class="info">
          <b>${escapeHtml(att.name || 'Unknown')}</b>
          <small>${att.distance ? 'd=' + att.distance.toFixed(2) : 'unidentified'}</small>
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
      const url = state.att.faceCrops[att.faceIdx];
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

  function reopenIdentify() {
    const unknowns = state.att.attendees.filter(a => a.isNew);
    if (unknowns.length === 0) return;
    openIdentifyModal(unknowns);
  }

  async function confirmIdentify() {
    const items = document.querySelectorAll('#identifyList .identify-item');
    setStatus('Saving identifications…', 'busy');
    try {
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
          // Match this face to existing person — add as a new training sample.
          const personId = sel;
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
          const thumbUrl = state.att.faceCrops[faceIdx];
          const desc     = state.att.faces[faceIdx].descriptor;
          const personId = await DB.addPerson({
            name: newName,
            descriptors: [desc],
            thumbUrl,
            firstSeen: new Date().toISOString(),
            lastSeen:  new Date().toISOString(),
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
      updateReIdentifyBtn();
      toast('Identifications saved.');
      setStatus('Ready.', 'ok');
    } catch (err) {
      console.error(err);
      toast('Save failed: ' + err.message, true);
      setStatus('Error.', 'error');
    }
  }

  function closeIdentifyModal() {
    document.getElementById('identifyModal').classList.add('hidden');
  }

  async function saveSession() {
    if (!state.att.imageBlob) return;

    setStatus('Saving session…', 'busy');
    const btn = document.getElementById('saveSessionBtn');
    btn.disabled = true;

    try {
      const W = state.att.image.naturalWidth;
      const H = state.att.image.naturalHeight;
      const label = document.getElementById('sessionLabel').value.trim();

      const session = {
        date: new Date().toISOString(),
        label,
        imageBlob: state.att.imageBlob,
        attendees: state.att.attendees.map(a => {
          const b = state.att.faces[a.faceIdx].box;
          return {
            personId: a.personId,
            name:     a.name || 'Anonymous',
            isAnonymous: !a.personId,
            // Normalized coords so they work after Firestore downscaling
            box: {
              x: b.x / W, y: b.y / H,
              width: b.width / W, height: b.height / H,
            },
          };
        }),
        faceCount: state.att.faces.length,
      };
      await DB.addSession(session);

      // Bump encounters/lastSeen for known attendees.
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
      renderReports();
      setStatus('Ready.', 'ok');
    } catch (err) {
      console.error(err);
      toast('Save failed: ' + err.message, true);
      setStatus('Save failed.', 'error');
      btn.disabled = false;
    }
  }

  function discardSession() {
    state.att = {
      image: null, imageBlob: null,
      faces: [], faceCrops: [], attendees: [], pending: false,
    };
    document.getElementById('sessionLabel').value = '';
    document.getElementById('attCanvas').classList.add('hidden');
    document.getElementById('attEmpty').classList.remove('hidden');
    document.getElementById('attendeesCard').hidden = true;
    document.getElementById('facesCount').textContent = '—';
    document.getElementById('recCount').textContent   = '—';
    document.getElementById('unkCount').textContent   = '—';
    document.getElementById('saveSessionBtn').disabled    = true;
    document.getElementById('discardSessionBtn').disabled = true;
    document.getElementById('reIdentifyBtn').hidden       = true;
  }

  // ===========================================================================
  // PEOPLE
  // ===========================================================================
  function renderPeople() {
    const grid = document.getElementById('peopleGrid');
    const term = (document.getElementById('peopleSearch').value || '').toLowerCase();
    const filtered = state.people
      .filter(p => p.name.toLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name));

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
      const url = p.thumbUrl || '';
      card.innerHTML = `
        <img class="person-thumb" src="${url}" alt="${escapeHtml(p.name)}"/>
        <div class="person-meta">
          <div class="person-name">${escapeHtml(p.name)}</div>
          <div class="person-stats">
            ${p.encounters || 0}× SEEN · ${(p.descriptors || []).length} SAMPLES
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
    const sessions = state.sessions.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const totalFaces = sessions.reduce((s, x) => s + (x.faceCount || 0), 0);
    const uniqPeople = new Set();
    sessions.forEach(s => (s.attendees || []).forEach(a => a.personId && uniqPeople.add(a.personId)));
    const lastDate = sessions[0]?.date;

    sums.innerHTML = `
      <div class="summary-box"><div class="v">${sessions.length}</div><div class="k">SESSIONS</div></div>
      <div class="summary-box"><div class="v">${totalFaces}</div><div class="k">TOTAL ATTENDANCE</div></div>
      <div class="summary-box"><div class="v">${uniqPeople.size}</div><div class="k">UNIQUE PEOPLE</div></div>
      <div class="summary-box"><div class="v">${lastDate ? formatDate(lastDate) : '—'}</div><div class="k">MOST RECENT</div></div>`;

    const tbody = document.getElementById('sessionsTbody');
    if (sessions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted center">No sessions recorded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    sessions.forEach(s => {
      const tr = document.createElement('tr');
      const pills = (s.attendees || []).map(a =>
        `<span class="att-pill ${a.isAnonymous ? 'unk' : ''}">${escapeHtml(a.name)}</span>`
      ).join('');
      tr.innerHTML = `
        <td>${formatDate(s.date)}</td>
        <td>${escapeHtml(s.label || s.roomName || '—')}</td>
        <td><b>${s.faceCount || (s.attendees || []).length}</b></td>
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
    const title = (s.label || s.roomName) ? `${s.label || s.roomName} · ${formatDate(s.date)}` : formatDate(s.date);
    document.getElementById('sessionModalTitle').textContent = title;
    const root = document.getElementById('sessionDetail');

    let view;
    try {
      const img = await urlToImage(s.imageUrl);
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.style.borderRadius = '4px';
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      (s.attendees || []).forEach(a => {
        if (!a.box) return;
        const bx = a.box.x * canvas.width;
        const by = a.box.y * canvas.height;
        const bw = a.box.width  * canvas.width;
        const bh = a.box.height * canvas.height;
        ctx.lineWidth = Math.max(2, canvas.width * 0.0025);
        ctx.strokeStyle = a.isAnonymous ? '#ffb547' : '#c8ff00';
        ctx.fillStyle   = a.isAnonymous ? '#ffb547' : '#c8ff00';
        ctx.strokeRect(bx, by, bw, bh);
        const fontSize = Math.max(14, canvas.width * 0.018);
        ctx.font = `700 ${fontSize}px JetBrains Mono, monospace`;
        const tw = ctx.measureText(a.name).width + fontSize * 0.8;
        ctx.fillRect(bx, by - fontSize * 1.4, tw, fontSize * 1.4);
        ctx.fillStyle = '#0a0d0a';
        ctx.textBaseline = 'middle';
        ctx.fillText(a.name, bx + fontSize * 0.4, by - fontSize * 0.7);
      });
      view = canvas;
    } catch (err) {
      view = document.createElement('div');
      view.style.padding = '24px';
      view.style.background = 'var(--bg-3)';
      view.style.borderRadius = '4px';
      view.style.color = 'var(--text-dim)';
      view.style.textAlign = 'center';
      view.textContent = 'Image unavailable.';
    }

    root.innerHTML = '';
    const left = document.createElement('div'); left.appendChild(view); root.appendChild(left);
    const right = document.createElement('div');
    right.innerHTML = `
      <div class="kv"><span>Date</span><strong>${formatDate(s.date)}</strong></div>
      ${(s.label || s.roomName) ? `<div class="kv"><span>Label</span><strong>${escapeHtml(s.label || s.roomName)}</strong></div>` : ''}
      <div class="kv"><span>Present</span><strong>${s.faceCount || (s.attendees || []).length}</strong></div>
      <h3 style="margin: 18px 0 10px;">ATTENDEES</h3>
      <div class="attendees">
        ${(s.attendees || []).map(a => `
          <div class="attendee${a.isAnonymous ? ' unk' : ''}">
            <div class="info">
              <b>${escapeHtml(a.name)}</b>
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
    const rows = [['session_id', 'date', 'label', 'person_id', 'person_name', 'is_anonymous']];
    for (const s of state.sessions) {
      for (const a of (s.attendees || [])) {
        rows.push([
          s.id, s.date, s.label || '',
          a.personId || '',
          a.name,
          a.isAnonymous ? 'true' : 'false',
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
    const text = prompt('Type RESET to wipe all people and sessions in your Firebase project. This cannot be undone.');
    if (text !== 'RESET') return;
    setStatus('Wiping data…', 'busy');
    try {
      await DB.reset();
      await refreshAll();
      renderReports();
      renderPeople();
      discardSession();
      toast('All data wiped.');
      setStatus('Ready.', 'ok');
    } catch (err) {
      toast('Reset failed: ' + err.message, true);
      setStatus('Error.', 'error');
    }
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
  function urlToImage(url) {
    return new Promise((resolve, reject) => {
      if (!url) return reject(new Error('No image URL'));
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load image from URL'));
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
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  }
  function formatDate(iso) {
    if (!iso) return '—';
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
    document.getElementById('statusDot').className = 'stat-dot' + (level ? ' ' + level : '');
  }
  function setModelStatus(msg) {
    document.getElementById('statusModel').textContent = msg;
  }

  // ----- BOOT UI -----
  function bootStatus(msg)   { document.getElementById('bootStatus').textContent = msg; }
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
    showLoadingScreen();
    bootStatus('BOOT ERROR');
    bootLog('> ERROR: ' + msg);
    setStatus('Boot failed — ' + msg, 'error');
    setModelStatus('MODELS: error');
    document.getElementById('bootHint').textContent =
      'Reload to retry. If this persists, check firebase-config.js and your Firestore rules.';
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
