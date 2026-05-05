/* =========================================================
   db.js — IndexedDB wrapper for ATTENDANCE.SYS
   Stores: rooms, people, sessions
========================================================= */

const DB = (() => {
  const NAME = 'attendance_sys';
  const VERSION = 1;
  let dbInstance = null;

  function open() {
    if (dbInstance) return Promise.resolve(dbInstance);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('rooms')) {
          const s = db.createObjectStore('rooms', { keyPath: 'id', autoIncrement: true });
          s.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('people')) {
          const s = db.createObjectStore('people', { keyPath: 'id', autoIncrement: true });
          s.createIndex('name', 'name');
        }
        if (!db.objectStoreNames.contains('sessions')) {
          const s = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
          s.createIndex('date', 'date');
          s.createIndex('roomId', 'roomId');
        }
      };
      req.onsuccess = () => { dbInstance = req.result; resolve(dbInstance); };
      req.onerror  = () => reject(req.error);
    });
  }

  function tx(store, mode = 'readonly') {
    return open().then(db => db.transaction(store, mode).objectStore(store));
  }
  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  // ROOMS
  async function addRoom(room)       { const s = await tx('rooms','readwrite'); return reqP(s.add(room)); }
  async function getRooms()          { const s = await tx('rooms');             return reqP(s.getAll()); }
  async function getRoom(id)         { const s = await tx('rooms');             return reqP(s.get(id)); }
  async function deleteRoom(id)      { const s = await tx('rooms','readwrite'); return reqP(s.delete(id)); }
  async function updateRoom(room)    { const s = await tx('rooms','readwrite'); return reqP(s.put(room)); }

  // PEOPLE
  async function addPerson(person)   { const s = await tx('people','readwrite'); return reqP(s.add(person)); }
  async function getPeople()         { const s = await tx('people');             return reqP(s.getAll()); }
  async function getPerson(id)       { const s = await tx('people');             return reqP(s.get(id)); }
  async function updatePerson(p)     { const s = await tx('people','readwrite'); return reqP(s.put(p)); }
  async function deletePerson(id)    { const s = await tx('people','readwrite'); return reqP(s.delete(id)); }

  // SESSIONS
  async function addSession(session) { const s = await tx('sessions','readwrite'); return reqP(s.add(session)); }
  async function getSessions()       { const s = await tx('sessions');             return reqP(s.getAll()); }
  async function getSession(id)      { const s = await tx('sessions');             return reqP(s.get(id)); }
  async function deleteSession(id)   { const s = await tx('sessions','readwrite'); return reqP(s.delete(id)); }

  // COUNTS
  async function counts() {
    const [rooms, people, sessions] = await Promise.all([
      tx('rooms').then(s   => reqP(s.count())),
      tx('people').then(s  => reqP(s.count())),
      tx('sessions').then(s => reqP(s.count())),
    ]);
    return { rooms, people, sessions };
  }

  // EXPORT / RESET
  async function exportAll() {
    const [rooms, people, sessions] = await Promise.all([getRooms(), getPeople(), getSessions()]);
    const toB64 = blob => blob ? blobToB64(blob) : null;
    const roomsExp = await Promise.all(rooms.map(async r => ({ ...r, imageBlob: await toB64(r.imageBlob) })));
    const peopleExp = await Promise.all(people.map(async p => ({
      ...p,
      thumbBlob: await toB64(p.thumbBlob),
      descriptors: (p.descriptors || []).map(d => Array.from(d)),
    })));
    const sessionsExp = await Promise.all(sessions.map(async s => ({ ...s, imageBlob: await toB64(s.imageBlob) })));
    return { version: 1, exportedAt: new Date().toISOString(), rooms: roomsExp, people: peopleExp, sessions: sessionsExp };
  }

  async function reset() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(['rooms','people','sessions'], 'readwrite');
      t.objectStore('rooms').clear();
      t.objectStore('people').clear();
      t.objectStore('sessions').clear();
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  }

  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload  = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  return {
    open, counts, reset, exportAll,
    addRoom, getRooms, getRoom, deleteRoom, updateRoom,
    addPerson, getPeople, getPerson, updatePerson, deletePerson,
    addSession, getSessions, getSession, deleteSession,
  };
})();
