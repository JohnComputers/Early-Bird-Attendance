/* =========================================================
   ml.js — Face detection + recognition wrapper
   Uses face-api.js (TinyFaceDetector + landmarks + 128-d descriptor)
========================================================= */

const ML = (() => {

  // Try GitHub-hosted weights via jsdelivr first; fall back to the
  // canonical github.io location maintained by the face-api.js author.
  const MODEL_URLS = [
    'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights',
    'https://justadudewhohacks.github.io/face-api.js/models',
  ];

  // Detection thresholds (lazily constructed so ml.js parses even if
  // face-api.js failed to load — we surface a cleaner error in init).
  let _detectorOptions = null;
  function detectorOptions() {
    if (!_detectorOptions) {
      _detectorOptions = new faceapi.TinyFaceDetectorOptions({
        inputSize: 512,        // good speed/quality balance
        scoreThreshold: 0.5,
      });
    }
    return _detectorOptions;
  }

  // Distance below which two descriptors are considered the same person.
  // face-api.js typically uses 0.6; we tighten slightly to reduce false matches.
  const MATCH_THRESHOLD = 0.55;

  let modelsLoaded = false;
  let modelsLoading = null;

  async function loadModels(onProgress = () => {}) {
    if (modelsLoaded) return;
    if (modelsLoading) return modelsLoading;

    modelsLoading = (async () => {
      let lastErr = null;
      for (const url of MODEL_URLS) {
        try {
          onProgress(`Loading face detector from ${shortHost(url)}…`, 10);
          await faceapi.nets.tinyFaceDetector.loadFromUri(url);

          onProgress('Loading face landmarks…', 50);
          await faceapi.nets.faceLandmark68Net.loadFromUri(url);

          onProgress('Loading face recognition…', 80);
          await faceapi.nets.faceRecognitionNet.loadFromUri(url);

          modelsLoaded = true;
          onProgress('Models ready.', 100);
          return;
        } catch (err) {
          lastErr = err;
          onProgress(`Mirror ${shortHost(url)} failed, trying fallback…`, 0);
        }
      }
      throw lastErr || new Error('Failed to load face-api models from any mirror.');
    })();

    return modelsLoading;
  }

  function shortHost(u) { try { return new URL(u).host; } catch { return u; } }

  /**
   * Detect all faces in an image and return their descriptors.
   * @param {HTMLImageElement|HTMLCanvasElement} img
   * @returns {Promise<Array<{box, descriptor, landmarks}>>}
   */
  async function detectFaces(img) {
    if (!modelsLoaded) throw new Error('Models not loaded');
    const results = await faceapi
      .detectAllFaces(img, detectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptors();

    return results.map(r => ({
      box: {
        x: r.detection.box.x,
        y: r.detection.box.y,
        width: r.detection.box.width,
        height: r.detection.box.height,
      },
      score: r.detection.score,
      descriptor: r.descriptor,           // Float32Array(128)
      landmarks: r.landmarks?.positions,
    }));
  }

  /**
   * Match a single descriptor against the roster.
   * Returns the best match if below threshold, otherwise null.
   */
  function matchFace(descriptor, people) {
    let best = { personId: null, distance: Infinity };
    for (const p of people) {
      const descs = p.descriptors || [];
      for (const d of descs) {
        const f32 = (d instanceof Float32Array) ? d : new Float32Array(d);
        const dist = faceapi.euclideanDistance(descriptor, f32);
        if (dist < best.distance) {
          best = { personId: p.id, distance: dist, name: p.name };
        }
      }
    }
    return best.distance < MATCH_THRESHOLD ? best : null;
  }

  /**
   * Crop a face region from an image and return as a Blob.
   */
  async function cropFace(img, box, padding = 0.25) {
    const pad = Math.max(box.width, box.height) * padding;
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    const w = Math.min(img.naturalWidth  - x, box.width  + pad * 2);
    const h = Math.min(img.naturalHeight - y, box.height + pad * 2);

    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 200;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, x, y, w, h, 0, 0, 200, 200);
    return new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  }

  /**
   * Assign each face to its nearest chair (by box-center distance).
   * Each chair receives at most one face (greedy by closest pair).
   */
  function assignFacesToChairs(faces, chairs) {
    const assignments = new Array(faces.length).fill(null);   // chairIndex per face
    const chairTaken = new Array(chairs.length).fill(false);

    if (chairs.length === 0) return assignments;

    // Build all (face,chair) distance pairs
    const pairs = [];
    faces.forEach((f, fi) => {
      const fcx = f.box.x + f.box.width / 2;
      const fcy = f.box.y + f.box.height / 2;
      chairs.forEach((c, ci) => {
        const dx = fcx - c.x, dy = fcy - c.y;
        pairs.push({ fi, ci, d: Math.hypot(dx, dy) });
      });
    });
    pairs.sort((a, b) => a.d - b.d);

    for (const p of pairs) {
      if (assignments[p.fi] !== null) continue;
      if (chairTaken[p.ci]) continue;
      assignments[p.fi] = p.ci;
      chairTaken[p.ci] = true;
    }
    return assignments;
  }

  return {
    loadModels,
    detectFaces,
    matchFace,
    cropFace,
    assignFacesToChairs,
    get ready() { return modelsLoaded; },
    MATCH_THRESHOLD,
  };
})();
