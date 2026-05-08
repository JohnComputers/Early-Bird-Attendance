/* ============================================================
   db.js — Firebase Firestore + Storage backend
   ------------------------------------------------------------
   Layout (all per-user, isolated by security rules):
     users/{uid}/rooms/{roomId}        → name, chairs, imageUrl, ...
     users/{uid}/people/{personId}     → name, descriptors, thumbUrl, ...
     users/{uid}/sessions/{sessionId}  → roomId, date, attendees, imageUrl, ...
   Storage:
     users/{uid}/rooms/{roomId}.jpg
     users/{uid}/people/{personId}.jpg
     users/{uid}/sessions/{sessionId}.jpg
   ------------------------------------------------------------
   Public API matches the original IndexedDB version. The only change
   for the app: read-side image fields are URLs ("imageUrl", "thumbUrl")
   instead of Blobs.
============================================================ */

const DB = (() => {

  // -------- helpers --------
  const fs = () => firebase.firestore();
  const st = () => firebase.storage();

  function uid() { return Auth.requireUid(); }
  function col(name) { return fs().collection(`users/${uid()}/${name}`); }
  function docRef(coll, id) { return fs().doc(`users/${uid()}/${coll}/${id}`); }
  function storageRef(path) { return st().ref(`users/${uid()}/${path}`); }

  // Firestore disallows directly nested arrays; wrap each Float32Array as { v: [...] }.
  function descToWire(d) {
    return { v: d instanceof Float32Array ? Array.from(d) : Array.from(d || []) };
  }
  function wireToDesc(o) {
    return new Float32Array(o.v || []);
  }

  async function uploadBlob(path, blob, contentType = 'image/jpeg') {
    const ref = storageRef(path);
    await ref.put(blob, { contentType });
    return ref.getDownloadURL();
  }
  async function deleteFile(path) {
    try { await storageRef(path).delete(); }
    catch (err) { /* not-found is fine */ }
  }

  // No-op kept so app.js can `await DB.open()` exactly as before.
  function open() { return Promise.resolve(); }

  // -------- ROOMS --------
  async function addRoom(room) {
    const ref = col('rooms').doc();          // auto-id
    const id = ref.id;
    let imageUrl = room.imageUrl || null;
    if (room.imageBlob) {
      imageUrl = await uploadBlob(`rooms/${id}.jpg`, room.imageBlob);
    }
    await ref.set({
      name: room.name,
      chairs: room.chairs || [],
      imgWidth: room.imgWidth,
      imgHeight: room.imgHeight,
      imageUrl,
      createdAt: room.createdAt || new Date().toISOString(),
    });
    return id;
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
    const ref = docRef('rooms', room.id);
    let imageUrl = room.imageUrl || null;
    if (room.imageBlob) {
      imageUrl = await uploadBlob(`rooms/${room.id}.jpg`, room.imageBlob);
    }
    await ref.set({
      name: room.name,
      chairs: room.chairs || [],
      imgWidth: room.imgWidth,
      imgHeight: room.imgHeight,
      imageUrl,
      createdAt: room.createdAt || new Date().toISOString(),
    });
  }

  async function deleteRoom(id) {
    await deleteFile(`rooms/${id}.jpg`);
    await docRef('rooms', id).delete();
  }

  // -------- PEOPLE --------
  async function addPerson(person) {
    const ref = col('people').doc();
    const id = ref.id;
    let thumbUrl = person.thumbUrl || null;
    if (person.thumbBlob) {
      thumbUrl = await uploadBlob(`people/${id}.jpg`, person.thumbBlob);
    }
    await ref.set({
      name: person.name,
      descriptors: (person.descriptors || []).map(descToWire),
      thumbUrl,
      firstSeen: person.firstSeen || new Date().toISOString(),
      lastSeen:  person.lastSeen  || new Date().toISOString(),
      encounters: person.encounters || 0,
    });
    return id;
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
    const ref = docRef('people', person.id);
    const update = {
      name: person.name,
      descriptors: (person.descriptors || []).map(descToWire),
      lastSeen: person.lastSeen || new Date().toISOString(),
      encounters: person.encounters || 0,
    };
    if (person.thumbBlob) {
      update.thumbUrl = await uploadBlob(`people/${person.id}.jpg`, person.thumbBlob);
    }
    await ref.update(update);
  }

  async function deletePerson(id) {
    await deleteFile(`people/${id}.jpg`);
    await docRef('people', id).delete();
  }

  // -------- SESSIONS --------
  async function addSession(session) {
    const ref = col('sessions').doc();
    const id = ref.id;
    let imageUrl = null;
    if (session.imageBlob) {
      imageUrl = await uploadBlob(`sessions/${id}.jpg`, session.imageBlob);
    }
    await ref.set({
      roomId:    session.roomId,
      roomName:  session.roomName,
      date:      session.date || new Date().toISOString(),
      imageUrl,
      attendees: session.attendees || [],
      faceCount: session.faceCount || 0,
      seatCount: session.seatCount || 0,
    });
    return id;
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
    await deleteFile(`sessions/${id}.jpg`);
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
      version: 2,
      backend: 'firebase',
      exportedAt: new Date().toISOString(),
      uid: uid(),
      rooms,
      // descriptors → plain arrays for portability
      people: people.map(p => ({
        ...p,
        descriptors: (p.descriptors || []).map(d => Array.from(d)),
      })),
      sessions,
    };
  }

  // -------- RESET --------
  async function reset() {
    // Delete all docs (in batches so we don't hit transaction limits on big datasets)
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
    // Delete all storage files for this user
    for (const folder of ['rooms', 'people', 'sessions']) {
      try {
        const list = await storageRef(folder).listAll();
        await Promise.all(list.items.map(item => item.delete().catch(() => {})));
      } catch { /* no folder yet, fine */ }
    }
  }

  return {
    open, counts, reset, exportAll,
    addRoom, getRooms, getRoom, updateRoom, deleteRoom,
    addPerson, getPeople, getPerson, updatePerson, deletePerson,
    addSession, getSessions, getSession, deleteSession,
  };
})();
