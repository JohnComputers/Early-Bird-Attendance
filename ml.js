/* =========================================================
   ml.js — Face detection + recognition wrapper
   Uses face-api.js (TinyFaceDetector + landmarks + 128-d descriptor)
========================================================= */

const ML = (() => {

  // Model weights served from the face-api.js GitHub repo via jsdelivr,
  // with the author's GitHub Pages mirror as a fallback.
  const MODEL_URLS = [
    'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights',
    'https://justadudewhohacks.github.io/face-api.js/models',
  ];

  // Detection thresholds (lazy so ml.js parses even if face-api failed to load)
  let _detectorOptions = null;
  function detectorOptions() {
    if (!_detectorOptions) {
      _detectorOptions = new faceapi.TinyFaceDetectorOptions({
        inputSize: 512,
        scoreThreshold: 0.5,
      });
    }
    return _detectorOptions;
  }

  // Distance below which two descriptors are considered the same person.
  // face-api.js default is 0.6; tighten slightly to reduce false matches.
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
   * Detect faces in an image. Boxes are in the image's natural pixel coords.
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
        width:  r.detection.box.width,
        height: r.detection.box.height,
      },
      score: r.detection.score,
      descriptor: r.descriptor,           // Float32Array(128)
      landmarks: r.landmarks?.positions,
    }));
  }

  /**
   * Match a single descriptor against the roster.
   * Returns best match if below MATCH_THRESHOLD, otherwise null.
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
   * Crop a face region from an image as a small JPEG data URL.
   * Returned string is suitable for use as img.src AND for storage.
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
    c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, 200, 200);
    return c.toDataURL('image/jpeg', 0.85);
  }

  /**
   * Assign each face to its nearest chair (normalized coordinates).
   * Each chair receives at most one face (greedy nearest-pair).
   *
   * @param faces     [{ box: { x,y,width,height } }]  pixel coords in image
   * @param chairs    [{ x, y }]                       NORMALIZED 0..1
   * @param imgWidth  image width in pixels
   * @param imgHeight image height in pixels
   */
  function assignFacesToChairs(faces, chairs, imgWidth, imgHeight) {
    const assignments = new Array(faces.length).fill(null);
    const chairTaken  = new Array(chairs.length).fill(false);
    if (chairs.length === 0) return assignments;

    const pairs = [];
    faces.forEach((f, fi) => {
      const fcx = (f.box.x + f.box.width  / 2) / imgWidth;   // → 0..1
      const fcy = (f.box.y + f.box.height / 2) / imgHeight;
      chairs.forEach((c, ci) => {
        const dx = fcx - c.x, dy = fcy - c.y;
        pairs.push({ fi, ci, d: Math.hypot(dx, dy) });
      });
    });
    pairs.sort((a, b) => a.d - b.d);

    for (const p of pairs) {
      if (assignments[p.fi] !== null) continue;
      if (chairTaken[p.ci])           continue;
      assignments[p.fi] = p.ci;
      chairTaken[p.ci]  = true;
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
