/* ============================================================
   auth.js — Firebase Auth wrapper
   Google sign-in. State is observed so app can react to changes.
============================================================ */

const Auth = (() => {
  let initialized = false;
  let currentUser = null;
  const listeners = new Set();

  function init() {
    if (initialized) return;

    const cfg = window.FIREBASE_CONFIG;
    if (!cfg || !cfg.projectId || cfg.projectId === 'your-project') {
      throw new Error(
        'Firebase is not configured. Edit firebase-config.js and paste your project config.'
      );
    }
    if (typeof firebase === 'undefined') {
      throw new Error('Firebase SDK failed to load. Check your network connection.');
    }

    firebase.initializeApp(cfg);

    // Best-effort offline cache for Firestore reads.
    // Fails silently on browsers that don't support it (e.g. private mode).
    try {
      firebase.firestore().enablePersistence({ synchronizeTabs: true })
        .catch(() => {});
    } catch {}

    firebase.auth().onAuthStateChanged(user => {
      currentUser = user;
      listeners.forEach(cb => { try { cb(user); } catch (e) { console.error(e); } });
    });

    initialized = true;
  }

  /** Resolves with the user (or null) the first time auth state is known. */
  function waitForFirstAuthState() {
    return new Promise(resolve => {
      const unsub = firebase.auth().onAuthStateChanged(user => {
        unsub();
        currentUser = user;
        resolve(user);
      });
    });
  }

  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  async function signInGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const result = await firebase.auth().signInWithPopup(provider);
      currentUser = result.user;
      return currentUser;
    } catch (err) {
      // Pop-up blockers / 3rd-party cookie blocks → redirect fallback
      if (err.code === 'auth/popup-blocked' ||
          err.code === 'auth/popup-closed-by-user' ||
          err.code === 'auth/cancelled-popup-request') {
        await firebase.auth().signInWithRedirect(provider);
        return null;
      }
      throw err;
    }
  }

  async function signOut() {
    await firebase.auth().signOut();
    currentUser = null;
  }

  function uid()  { return currentUser?.uid || null; }
  function user() { return currentUser; }
  function requireUid() {
    if (!currentUser) throw new Error('Not signed in');
    return currentUser.uid;
  }

  return {
    init,
    waitForFirstAuthState,
    onChange,
    signInGoogle,
    signOut,
    uid, user, requireUid,
  };
})();
