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
   * Whole-image detection (used by the "auto-detect" helper button).
   * Returns boxes in the image's natural pixel coords + 128-d descriptors.
   */
  async function detectFaces(img) {
    if (!modelsLoaded) throw new Error('Models not loaded');
    const opts = new faceapi.TinyFaceDetectorOptions({
      inputSize: 608,             // larger input → catches smaller faces in group shots
      scoreThreshold: 0.4,        // somewhat lenient
    });
    const results = await faceapi
      .detectAllFaces(img, opts)
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
      descriptor: r.descriptor,
    }));
  }

  /**
   * Focused detection around a user-clicked point.
   *
   * Strategy:
   *   1. Crop a generous region (~30% of image dimension) around the click.
   *   2. Run sensitive detection on JUST that region.
   *   3. Take the detected face closest to the click point.
   *   4. If nothing detected at all, fall back to computing a descriptor
   *      directly on a centered face-sized crop. This is less accurate
   *      (no alignment) but still produces a usable descriptor.
   *
   * Boxes returned are in the ORIGINAL image's coordinate space.
   *
   * @param img      HTMLImageElement
   * @param normX    normalized 0..1 click position on the image
   * @param normY    same
   * @returns        { box, descriptor, score, method } | null
   */
  async function detectFaceNearPoint(img, normX, normY) {
    if (!modelsLoaded) throw new Error('Models not loaded');

    const W = img.naturalWidth, H = img.naturalHeight;
    const px = normX * W, py = normY * H;

    const regionSize = Math.max(280, Math.min(W, H) * 0.30);
    const half = regionSize / 2;
    const sx = Math.max(0, Math.min(W - regionSize, px - half));
    const sy = Math.max(0, Math.min(H - regionSize, py - half));
    const sw = Math.min(W - sx, regionSize);
    const sh = Math.min(H - sy, regionSize);

    const region = document.createElement('canvas');
    region.width = sw; region.height = sh;
    region.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    // Sensitive detection on the focused crop.
    const opts = new faceapi.TinyFaceDetectorOptions({
      inputSize: 416,
      scoreThreshold: 0.2,          // very lenient — we already know there's a face here
    });

    const detections = await faceapi
      .detectAllFaces(region, opts)
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (detections.length > 0) {
      // Pick the face whose center is closest to the click point.
      const cx = px - sx, cy = py - sy;
      let best = detections[0], bestDist = Infinity;
      for (const d of detections) {
        const dcx = d.detection.box.x + d.detection.box.width  / 2;
        const dcy = d.detection.box.y + d.detection.box.height / 2;
        const dist = Math.hypot(dcx - cx, dcy - cy);
        if (dist < bestDist) { best = d; bestDist = dist; }
      }
      return {
        box: {
          x: best.detection.box.x + sx,
          y: best.detection.box.y + sy,
          width:  best.detection.box.width,
          height: best.detection.box.height,
        },
        descriptor: best.descriptor,
        score: best.detection.score,
        method: 'detected',
      };
    }

    // Fallback: no face detected. Build a descriptor directly from a centered
    // face-sized crop. Less accurate alignment, but it'll still try to match.
    const fallbackSize = Math.max(160, Math.min(W, H) * 0.18);
    const fx = Math.max(0, Math.min(W - fallbackSize, px - fallbackSize / 2));
    const fy = Math.max(0, Math.min(H - fallbackSize, py - fallbackSize / 2));
    const fw = Math.min(W - fx, fallbackSize);
    const fh = Math.min(H - fy, fallbackSize);

    const aligned = document.createElement('canvas');
    aligned.width = 150; aligned.height = 150;       // FaceRecognitionNet input size
    aligned.getContext('2d').drawImage(img, fx, fy, fw, fh, 0, 0, 150, 150);

    try {
      const descriptor = await faceapi.computeFaceDescriptor(aligned);
      return {
        box: { x: fx, y: fy, width: fw, height: fh },
        descriptor,
        score: 0,
        method: 'fallback',
      };
    } catch {
      return null;
    }
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
   */
  async function cropFace(img, box, padding = 0.25) {
    const pad = Math.max(box.width, box.height) * padding;
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    const w = Math.min(img.naturalWidth  - x, box.width  + pad * 2);
    const h = Math.min(img.naturalHeight - y, box.height + pad * 2);
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, 200, 200);
    return c.toDataURL('image/jpeg', 0.85);
  }

  return {
    loadModels,
    detectFaces,            // whole-image (for auto-detect helper)
    detectFaceNearPoint,    // focused (per-click)
    matchFace,
    cropFace,
    get ready() { return modelsLoaded; },
    MATCH_THRESHOLD,
  };
})();
