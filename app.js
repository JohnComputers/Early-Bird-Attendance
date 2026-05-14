/* =========================================================
   app.js — ATTENDANCE.SYS main controller (click-to-mark)

   Flow:
     1. Upload photo
     2. Click each person's face → marker placed, focused detection runs
        on a region around that click, descriptor matched against roster
     3. Identify any unknowns
     4. Save session
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
      markers:   [],         // see makeMarker() below
      nextNum:   1,
    },
  };

  /**
   * Marker shape:
   *   {
   *     id:       'm1234abc',
   *     num:      1,
   *     nx, ny:   normalized 0..1 click position
   *     state:    'pending' | 'detected' | 'failed'
   *     face:     { box, descriptor } | null
   *     crop:     data-URL string | null
   *     attendee: { personId, name, isNew, distance } | null
   *     method:   'detected' | 'fallback' | 'auto' | undefined
   *   }
   */
  function makeMarker(nx, ny) {
    return {
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      num: state.att.nextNum++,
      nx, ny,
      state: 'pending',
      face: null, crop: null, attendee: null,
    };
  }

  // ---------------------------------------------------------------------------
  // BOOT
  // ---------------------------------------------------------------------------
  async function init() {
    bindGlobalEvents();
    bindSignInEvents();

    bootStatus('CONNECTING TO FIREBASE…');
    try { Auth.init(); }
    catch (err) { return bootFail(err.message); }
    bootLog('> Firebase initialized.');
    bootProgress(8);

    bootStatus('CHECKING AUTH STATE…');
    const user = await Auth.waitForFirstAuthState();
    if (!user) { showSignInScreen(); return; }
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
    } catch (err) { return bootFail(err.message); }
    bootProgress(85);

    bootStatus('LOADING DATA…');
    try { await refreshAll(); }
    catch (err) {
      return bootFail('Could not load data: ' + err.message +
        ' — verify your Firestore rules allow this user to read /users/{uid}.');
    }
    bootProgress(100);
    bootLog('> All systems online.');

    setTimeout(hideBoot, 450);
    setStatus('Ready. Upload a photo, then click on each person\'s face.', 'ok');
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
      const t = e.target.closest('.tab'); if (!t) return;
      switchTab(t.dataset.tab);
    });

    document.getElementById('attFile').addEventListener('change', onAttFile);
    document.getElementById('attCanvas').addEventListener('click', onCanvasClick);
    document.getElementById('autoDetectBtn').addEventListener('click', autoDetect);
    document.getElementById('clearMarkersBtn').addEventListener('click', clearMarkers);
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
      if (file && file.type.startsWith('image/')) loadAttPhoto(file);
    });

    window.addEventListener('resize', () => { if (state.att.image) drawAttCanvas(); });
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
    if (file) await loadAttPhoto(file);
  }

  async function loadAttPhoto(file) {
    setStatus('Loading photo…');
    try {
      const img = await fileToImage(file);
      state.att = {
        image: img, imageBlob: file,
        markers: [], nextNum: 1,
      };

      document.getElementById('attEmpty').classList.add('hidden');
      const c = document.getElementById('attCanvas');
      c.classList.remove('hidden');
      drawAttCanvas();
      updateAttUI();

      document.getElementById('autoDetectBtn').disabled = false;
      document.getElementById('discardSessionBtn').disabled = false;

      setStatus('Click on each person\'s face to mark them present.', 'ok');
    } catch (err) {
      console.error(err);
      toast('Failed to load image: ' + err.message, true);
      setStatus('Failed.', 'error');
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
    c.width  = img.naturalWidth;
    c.height = img.naturalHeight;
    fitCanvas(c);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    state.att.markers.forEach(m => drawMarker(ctx, m, c));
  }

  function drawMarker(ctx, m, c) {
    const fontSize = Math.max(14, c.width * 0.018);
    ctx.save();

    if (m.state === 'detected' && m.face) {
      // Face box + name label
      const { x, y, width, height } = m.face.box;
      const isUnk  = m.attendee.isNew;
      const isAnon = m.attendee.name === 'Anonymous';
      const color = isUnk ? '#ffb547' : (isAnon ? '#8a948a' : '#c8ff00');

      ctx.lineWidth = Math.max(2, c.width * 0.0025);
      ctx.strokeStyle = color;
      ctx.fillStyle   = color;
      ctx.strokeRect(x, y, width, height);

      const label = `${m.num} · ${m.attendee.name || (isUnk ? 'NEW?' : '?')}`;
      ctx.font = `700 ${fontSize}px JetBrains Mono, monospace`;
      const pad = fontSize * 0.4;
      const tw  = ctx.measureText(label).width + pad * 2;
      ctx.fillRect(x, y - fontSize - pad, tw, fontSize + pad);
      ctx.fillStyle = '#0a0d0a';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + pad, y - (fontSize + pad) / 2);

    } else if (m.state === 'pending') {
      // Animated dashed circle at click point
      const px = m.nx * c.width, py = m.ny * c.height;
      const r  = Math.max(22, Math.min(c.width, c.height) * 0.022);
      const t  = Date.now() / 400;
      const phase = (Math.sin(t) + 1) / 2;
      ctx.lineWidth = Math.max(2, r * 0.16);
      ctx.strokeStyle = '#6ad6ff';
      ctx.fillStyle = `rgba(106,214,255,${0.15 + 0.15 * phase})`;
      ctx.setLineDash([r * 0.4, r * 0.3]);
      ctx.lineDashOffset = -t * 4;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      // number
      ctx.fillStyle = '#6ad6ff';
      ctx.font = `700 ${r * 0.7}px JetBrains Mono, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(m.num), px, py);

    } else if (m.state === 'failed') {
      // Red X at click point
      const px = m.nx * c.width, py = m.ny * c.height;
      const r  = Math.max(22, Math.min(c.width, c.height) * 0.022);
      ctx.lineWidth = Math.max(3, r * 0.18);
      ctx.strokeStyle = '#ff5959';
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px - r * 0.5, py - r * 0.5); ctx.lineTo(px + r * 0.5, py + r * 0.5);
      ctx.moveTo(px + r * 0.5, py - r * 0.5); ctx.lineTo(px - r * 0.5, py + r * 0.5);
      ctx.stroke();
      // small number badge
      ctx.fillStyle = '#ff5959';
      ctx.font = `700 ${fontSize * 0.7}px JetBrains Mono, monospace`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`#${m.num}`, px + r + 4, py - r);
    }
    ctx.restore();
  }

  // Animation loop while any marker is pending
  let rafId = null;
  function ensureAnimating() {
    if (rafId) return;
    const tick = () => {
      const c = document.getElementById('attCanvas');
      if (!c || c.classList.contains('hidden')) { rafId = null; return; }
      const stillPending = state.att.markers.some(m => m.state === 'pending');
      drawAttCanvas();
      if (stillPending) rafId = requestAnimationFrame(tick);
      else rafId = null;
    };
    rafId = requestAnimationFrame(tick);
  }

  // ----------- CLICK ON CANVAS -----------
  async function onCanvasClick(e) {
    const c = e.currentTarget;
    if (c.classList.contains('hidden') || !state.att.image) return;

    const rect = c.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (c.width  / rect.width);
    const py = (e.clientY - rect.top)  * (c.height / rect.height);
    const nx = px / c.width;
    const ny = py / c.height;

    // Hit test: if the click landed inside an existing detected face box, or near
    // a pending/failed dot, remove that marker instead of adding a new one.
    const hitRadius = Math.max(28, c.width * 0.025);
    const hitIdx = state.att.markers.findIndex(m => {
      if (m.state === 'detected' && m.face) {
        const b = m.face.box;
        return px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height;
      }
      const mpx = m.nx * c.width, mpy = m.ny * c.height;
      return Math.hypot(mpx - px, mpy - py) < hitRadius;
    });
    if (hitIdx >= 0) {
      state.att.markers.splice(hitIdx, 1);
      drawAttCanvas();
      updateAttUI();
      return;
    }

    // New marker
    const marker = makeMarker(nx, ny);
    state.att.markers.push(marker);
    drawAttCanvas();
    updateAttUI();
    ensureAnimating();

    await processMarker(marker);
  }

  async function processMarker(marker) {
    try {
      const result = await ML.detectFaceNearPoint(state.att.image, marker.nx, marker.ny);
      const live = state.att.markers.find(m => m.id === marker.id);
      if (!live) return; // user removed it while we were thinking

      if (!result) {
        live.state = 'failed';
      } else {
        live.face = { box: result.box, descriptor: result.descriptor };
        live.method = result.method;
        live.crop = await ML.cropFace(state.att.image, result.box);
        const match = ML.matchFace(result.descriptor, state.people);
        live.attendee = {
          personId: match ? match.personId : null,
          name:     match ? match.name     : null,
          isNew:    !match,
          distance: match ? match.distance : null,
        };
        live.state = 'detected';
      }
    } catch (err) {
      console.error(err);
      const live = state.att.markers.find(m => m.id === marker.id);
      if (live) live.state = 'failed';
    }
    drawAttCanvas();
    updateAttUI();
  }

  function updateAttUI() {
    const ms = state.att.markers;
    document.getElementById('markerCount').textContent = ms.length || '—';
    document.getElementById('recCount').textContent =
      ms.filter(m => m.state === 'detected' && !m.attendee.isNew && m.attendee.personId).length || '—';
    document.getElementById('unkCount').textContent =
      ms.filter(m => m.state === 'detected' && m.attendee.isNew).length || '—';
    document.getElementById('failCount').textContent =
      ms.filter(m => m.state === 'failed').length || '—';

    document.getElementById('clearMarkersBtn').disabled = ms.length === 0;
    document.getElementById('saveSessionBtn').disabled  =
      ms.length === 0 || ms.some(m => m.state === 'pending');

    const unknowns = ms.filter(m => m.state === 'detected' && m.attendee.isNew).length;
    const reBtn = document.getElementById('reIdentifyBtn');
    reBtn.hidden = unknowns === 0;
    if (unknowns > 0) reBtn.textContent = `IDENTIFY ${unknowns} UNKNOWN${unknowns === 1 ? '' : 'S'}`;

    renderAttendeesList();
  }

  function renderAttendeesList() {
    const ms = state.att.markers;
    document.getElementById('attendeesCard').hidden = ms.length === 0;
    const root = document.getElementById('attendeesList');
    if (ms.length === 0) { root.innerHTML = ''; return; }

    root.innerHTML = '<div class="attendees"></div>';
    const list = root.querySelector('.attendees');

    // Sort: detected/known → detected/unknown → pending → failed; alphabetical within each
    const order = m =>
      (m.state === 'detected' && m.attendee && !m.attendee.isNew) ? 0 :
      (m.state === 'detected' && m.attendee && m.attendee.isNew)  ? 1 :
      (m.state === 'pending') ? 2 : 3;
    const sorted = ms.slice().sort((a, b) => {
      const oa = order(a), ob = order(b);
      if (oa !== ob) return oa - ob;
      return (a.attendee?.name || '').localeCompare(b.attendee?.name || '');
    });

    sorted.forEach(m => {
      const div = document.createElement('div');
      let cls = 'attendee';
      let name, sub, badge, badgeCls;

      if (m.state === 'pending') {
        cls += ' pending'; name = 'Detecting…'; sub = `Marker #${m.num}`;
        badge = 'PENDING'; badgeCls = 'pending';
      } else if (m.state === 'failed') {
        cls += ' failed'; name = 'No face here'; sub = `Marker #${m.num} · click to remove and try again`;
        badge = 'FAILED'; badgeCls = 'failed';
      } else if (m.attendee.isNew) {
        cls += ' unk'; name = 'Unknown'; sub = `Marker #${m.num} · click "IDENTIFY UNKNOWNS"`;
        badge = 'NEW'; badgeCls = 'new';
      } else {
        name = m.attendee.name;
        sub  = `Marker #${m.num}${m.attendee.distance ? ' · d=' + m.attendee.distance.toFixed(2) : ''}${m.method === 'fallback' ? ' · low conf' : ''}`;
        badge = 'KNOWN'; badgeCls = 'ok';
      }

      div.className = cls;
      const thumb = m.crop
        ? `<img src="${m.crop}" alt="" />`
        : `<div class="placeholder-thumb">${m.num}</div>`;
      div.innerHTML = `
        ${thumb}
        <div class="info">
          <b>${escapeHtml(name)}</b>
          <small>${escapeHtml(sub)}</small>
        </div>
        <span class="badge ${badgeCls}">${badge}</span>`;
      list.appendChild(div);
    });
  }

  function clearMarkers() {
    if (state.att.markers.length === 0) return;
    if (!confirm('Remove all markers?')) return;
    state.att.markers = [];
    state.att.nextNum = 1;
    drawAttCanvas();
    updateAttUI();
  }

  async function autoDetect() {
    if (!state.att.image) return;
    const btn = document.getElementById('autoDetectBtn');
    btn.disabled = true;
    setStatus('Scanning whole photo…', 'busy');
    try {
      const faces = await ML.detectFaces(state.att.image);
      const W = state.att.image.naturalWidth, H = state.att.image.naturalHeight;
      for (const f of faces) {
        const cx = (f.box.x + f.box.width  / 2) / W;
        const cy = (f.box.y + f.box.height / 2) / H;
        // Skip if there's already a marker within hit radius
        const exists = state.att.markers.some(m =>
          Math.hypot((m.nx - cx) * W, (m.ny - cy) * H) < Math.max(28, W * 0.025));
        if (exists) continue;

        const m = makeMarker(cx, cy);
        m.state = 'detected';
        m.face = { box: f.box, descriptor: f.descriptor };
        m.method = 'auto';
        m.crop = await ML.cropFace(state.att.image, f.box);
        const match = ML.matchFace(f.descriptor, state.people);
        m.attendee = {
          personId: match ? match.personId : null,
          name:     match ? match.name     : null,
          isNew:    !match,
          distance: match ? match.distance : null,
        };
        state.att.markers.push(m);
      }
      drawAttCanvas();
      updateAttUI();
      setStatus(faces.length === 0
        ? 'Auto-detect found no faces — try clicking manually.'
        : `Auto-detect added ${faces.length} marker${faces.length === 1 ? '' : 's'}.`,
        'ok');
    } catch (err) {
      console.error(err);
      toast('Auto-detect failed: ' + err.message, true);
      setStatus('Error.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ----- IDENTIFY MODAL -----
  function openIdentifyModal(markers) {
    const root = document.getElementById('identifyList');
    root.innerHTML = '';
    markers.forEach(m => {
      const div = document.createElement('div');
      div.className = 'identify-item';
      div.dataset.markerId = m.id;
      div.innerHTML = `
        <img src="${m.crop}" alt="" />
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
    const unknowns = state.att.markers.filter(m => m.state === 'detected' && m.attendee.isNew);
    if (unknowns.length > 0) openIdentifyModal(unknowns);
  }

  async function confirmIdentify() {
    const items = document.querySelectorAll('#identifyList .identify-item');
    setStatus('Saving identifications…', 'busy');
    try {
      for (const item of items) {
        const markerId = item.dataset.markerId;
        const sel = item.querySelector('.existing-sel').value;
        const newName = item.querySelector('.new-name').value.trim();
        const m = state.att.markers.find(x => x.id === markerId);
        if (!m || !m.face) continue;

        if (sel === '__skip' && !newName) {
          m.attendee.name = 'Anonymous';
          m.attendee.personId = null;
          m.attendee.isNew = false;
          continue;
        }
        if (sel && sel !== '__skip') {
          // Add face as a sample to existing person
          const personId = sel;
          const person = state.people.find(p => p.id === personId);
          if (person) {
            person.descriptors = (person.descriptors || []).concat([m.face.descriptor]);
            await DB.updatePerson(person);
            m.attendee.personId = person.id;
            m.attendee.name = person.name;
            m.attendee.isNew = false;
          }
          continue;
        }
        if (newName) {
          const personId = await DB.addPerson({
            name: newName,
            descriptors: [m.face.descriptor],
            thumbUrl: m.crop,
            firstSeen: new Date().toISOString(),
            lastSeen:  new Date().toISOString(),
            encounters: 0,
          });
          m.attendee.personId = personId;
          m.attendee.name = newName;
          m.attendee.isNew = false;
        }
      }
      closeIdentifyModal();
      await refreshAll();
      drawAttCanvas();
      updateAttUI();
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
    const detected = state.att.markers.filter(m => m.state === 'detected');
    if (detected.length === 0) {
      toast('No detected faces to save.', true);
      return;
    }

    const unknowns = detected.filter(m => m.attendee.isNew);
    if (unknowns.length > 0) {
      const proceed = confirm(`${unknowns.length} unknown face${unknowns.length === 1 ? '' : 's'} not yet identified. Save anyway (they'll be marked Anonymous)?`);
      if (!proceed) return;
      unknowns.forEach(m => {
        m.attendee.name = 'Anonymous';
        m.attendee.isNew = false;
        m.attendee.personId = null;
      });
    }

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
        attendees: detected.map(m => ({
          personId: m.attendee.personId,
          name:     m.attendee.name,
          isAnonymous: !m.attendee.personId,
          box: {
            x: m.face.box.x / W, y: m.face.box.y / H,
            width: m.face.box.width / W, height: m.face.box.height / H,
          },
        })),
        faceCount: detected.length,
      };
      await DB.addSession(session);

      // Bump encounters/lastSeen for known attendees
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
      markers: [], nextNum: 1,
    };
    document.getElementById('sessionLabel').value = '';
    document.getElementById('attCanvas').classList.add('hidden');
    document.getElementById('attEmpty').classList.remove('hidden');
    document.getElementById('attendeesCard').hidden = true;
    document.getElementById('markerCount').textContent = '—';
    document.getElementById('recCount').textContent    = '—';
    document.getElementById('unkCount').textContent    = '—';
    document.getElementById('failCount').textContent   = '—';
    document.getElementById('autoDetectBtn').disabled  = true;
    document.getElementById('clearMarkersBtn').disabled = true;
    document.getElementById('saveSessionBtn').disabled  = true;
    document.getElementById('discardSessionBtn').disabled = true;
    document.getElementById('reIdentifyBtn').hidden    = true;
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
          <button class="btn ghost no-stack" data-view="${s.id}">VIEW</button>
          <button class="btn ghost no-stack" data-del="${s.id}">DEL</button>
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
            <div class="info"><b>${escapeHtml(a.name)}</b></div>
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
    document.body.appendChild(a); a.click(); a.remove();
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
