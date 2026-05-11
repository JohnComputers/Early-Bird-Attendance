/* ============================================================
   db.js — Firestore-only backend (no Storage / no paid plan needed)
   ------------------------------------------------------------
   Images are downscaled and stored as base64 data URLs *inside*
   the Firestore documents themselves. Firestore allows ~1 MB per
   document, which comfortably fits a downscaled JPEG at quality 0.7.

   Layout (per signed-in user, isolated by security rules):
     users/{uid}/rooms/{roomId}        → name, chairs, imageUrl, ...
     users/{uid}/people/{personId}     → name, descriptors, thumbUrl, ...
     users/{uid}/sessions/{sessionId}  → roomId, date, attendees, imageUrl, ...

   Coordinate convention:
     - chairs:     { x, y }       in 0..1 normalized (image-relative)
     - box (att.): { x,y,w,h }    in 0..1 normalized (image-relative)
   This lets the room and attendance photos have different
   resolutions without alignment breaking.
============================================================ */

const DB = (() => {

  const fs = () => firebase.firestore();

  function uid() { return Auth.requireUid(); }
  function col(name) { return fs().collection(`users/${uid()}/${name}`); }
  function docRef(coll, id) { return fs().doc(`users/${uid()}/${coll}/${id}`); }

  // Firestore disallows directly nested arrays; wrap each descriptor.
  function descToWire(d) {
    return { v: d instanceof Float32Array ? Array.from(d) : Array.from(d || []) };
  }
  function wireToDesc(o) {
    return new Float32Array(o.v || []);
  }

  // Per-document budget. Firestore hard limit is 1,048,487 bytes — leave headroom.
  const MAX_DOC_BYTES = 900_000;

  /**
   * Take a Blob → downscaled JPEG data URL string.
   * Progressively reduces dimensions/quality until under MAX_DOC_BYTES.
   */
  async function blobToCompressedDataUrl(blob, opts = {}) {
    const { maxDim = 1280, quality = 0.7, budget = MAX_DOC_BYTES } = opts;
    const img = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const im  = new Image();
      im.onload  = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode failed')); };
      im.src = url;
    });

    let dim = maxDim;
    let q   = quality;
    let dataUrl = encode(img, dim, q);

    // Pull both knobs until small enough.
    while (dataUrl.length > budget && (q > 0.35 || dim > 480)) {
      if (q > 0.35) q = Math.max(0.35, q - 0.08);
      else          dim = Math.max(480, Math.round(dim * 0.85));
      dataUrl = encode(img, dim, q);
    }
    return dataUrl;
  }

  function encode(img, maxDim, quality) {
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth  * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality);
  }

  // No-op kept so app.js can `await DB.open()` exactly as before.
  function open() { return Promise.resolve(); }

  // -------- ROOMS --------
  async function addRoom(room) {
    let imageUrl = room.imageUrl || null;
    if (room.imageBlob) {
      imageUrl = await blobToCompressedDataUrl(room.imageBlob, { maxDim: 1280, quality: 0.7 });
    }
    const ref = col('rooms').doc();
    await ref.set({
      name: room.name,
      chairs: room.chairs || [],
      imageUrl,
      createdAt: room.createdAt || new Date().toISOString(),
    });
    return ref.id;
  }

  async function getRooms() {
    const snap = await col('rooms').orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function getRoom(id) {
    const snap = await docRef('rooms', id).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  async function updateRoom(room) {
    let imageUrl = room.imageUrl || null;
    if (room.imageBlob) {
      imageUrl = await blobToCompressedDataUrl(room.imageBlob, { maxDim: 1280, quality: 0.7 });
    }
    await docRef('rooms', room.id).set({
      name: room.name,
      chairs: room.chairs || [],
      imageUrl,
      createdAt: room.createdAt || new Date().toISOString(),
    });
  }

  async function deleteRoom(id) {
    await docRef('rooms', id).delete();
  }

  // -------- PEOPLE --------
  // thumbUrl is a small (~200px) JPEG data URL produced by ML.cropFace.
  async function addPerson(person) {
    const ref = col('people').doc();
    await ref.set({
      name: person.name,
      descriptors: (person.descriptors || []).map(descToWire),
      thumbUrl: person.thumbUrl || null,
      firstSeen: person.firstSeen || new Date().toISOString(),
      lastSeen:  person.lastSeen  || new Date().toISOString(),
      encounters: person.encounters || 0,
    });
    return ref.id;
  }

  async function getPeople() {
    const snap = await col('people').get();
    return snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        descriptors: (data.descriptors || []).map(wireToDesc),
      };
    });
  }

  async function getPerson(id) {
    const snap = await docRef('people', id).get();
    if (!snap.exists) return null;
    const data = snap.data();
    return { id: snap.id, ...data, descriptors: (data.descriptors || []).map(wireToDesc) };
  }

  async function updatePerson(person) {
    const update = {
      name: person.name,
      descriptors: (person.descriptors || []).map(descToWire),
      lastSeen: person.lastSeen || new Date().toISOString(),
      encounters: person.encounters || 0,
    };
    if (person.thumbUrl) update.thumbUrl = person.thumbUrl;
    await docRef('people', person.id).update(update);
  }

  async function deletePerson(id) {
    await docRef('people', id).delete();
  }

  // -------- SESSIONS --------
  async function addSession(session) {
    let imageUrl = null;
    if (session.imageBlob) {
      imageUrl = await blobToCompressedDataUrl(session.imageBlob, { maxDim: 1280, quality: 0.7 });
    }
    const ref = col('sessions').doc();
    await ref.set({
      roomId:    session.roomId,
      roomName:  session.roomName,
      date:      session.date || new Date().toISOString(),
      imageUrl,
      attendees: session.attendees || [],
      faceCount: session.faceCount || 0,
      seatCount: session.seatCount || 0,
    });
    return ref.id;
  }

  async function getSessions() {
    const snap = await col('sessions').orderBy('date', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function getSession(id) {
    const snap = await docRef('sessions', id).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  async function deleteSession(id) {
    await docRef('sessions', id).delete();
  }

  // -------- COUNTS --------
  async function counts() {
    const [r, p, s] = await Promise.all([
      col('rooms').get(), col('people').get(), col('sessions').get(),
    ]);
    return { rooms: r.size, people: p.size, sessions: s.size };
  }

  // -------- EXPORT --------
  async function exportAll() {
    const [rooms, people, sessions] = await Promise.all([
      getRooms(), getPeople(), getSessions(),
    ]);
    return {
      version: 3,
      backend: 'firestore-only',
      exportedAt: new Date().toISOString(),
      uid: uid(),
      rooms,
      people: people.map(p => ({
        ...p,
        descriptors: (p.descriptors || []).map(d => Array.from(d)),
      })),
      sessions,
    };
  }

  // -------- RESET --------
  async function reset() {
    for (const name of ['rooms', 'people', 'sessions']) {
      const snap = await col(name).get();
      const docs = snap.docs;
      while (docs.length) {
        const chunk = docs.splice(0, 400);
        const batch = fs().batch();
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }
  }

  return {
    open, counts, reset, exportAll,
    addRoom, getRooms, getRoom, updateRoom, deleteRoom,
    addPerson, getPeople, getPerson, updatePerson, deletePerson,
    addSession, getSessions, getSession, deleteSession,
  };
})();
