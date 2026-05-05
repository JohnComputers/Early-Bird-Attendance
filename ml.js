/* =========================================================
   ml.js — Machine learning layer for ATTENDANCE.SYS
   Wraps face-api.js: model loading, detection, matching
========================================================= */

const ML = (() => {
  // face-api.js@0.22.2 ships its weights inside the npm package
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights';

  let modelsLoaded = false;
  let loading = false;

  /* ----------------------------------------------------------
     loadModels(onLog, onProgress)
     onLog(htmlString) — appended to boot log
     onProgress(0-100) — raw percentage, mapped by caller
  ---------------------------------------------------------- */
  async function loadModels(onLog, onProgress) {
    if (modelsLoaded) return;
    if (loading) {
      // wait for the in-flight load
      while (loading) await new Promise(r => setTimeout(r, 100));
      return;
    }
    loading = true;
    try {
      onLog?.('> Fetching SSD MobileNet v1 (face detector)…');
      onProgress?.(10);
      await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);

      onLog?.('> Fetching 68-point face landmark model…');
      onProgress?.(45);
      await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);

      onLog?.('> Fetching 128-d face recognition model…');
      onProgress?.(75);
      await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);

      modelsLoaded = true;
      onProgress?.(100);
      onLog?.('> <b>All models ready. System online.</b>');
    } finally {
      loading = false;
    }
  }

  /* ----------------------------------------------------------
     detectFaces(imgElement) → faceapi detections[]
  ---------------------------------------------------------- */
  async function detectFaces(imgEl) {
    if (!modelsLoaded) throw new Error('Models not loaded yet');
    const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.38 });
    return faceapi
      .detectAllFaces(imgEl, options)
      .withFaceLandmarks()
      .withFaceDescriptors();
  }

  /* ----------------------------------------------------------
     matchFace(descriptor, people, threshold)
     descriptor  — Float32Array from faceapi
     people      — array of DB person objects (with .descriptors)
     Returns     — { person, distance } or null
  ---------------------------------------------------------- */
  function matchFace(descriptor, people, threshold = 0.52) {
    let bestPerson = null;
    let bestDist   = Infinity;

    for (const person of people) {
      const descs = person.descriptors || [];
      for (const raw of descs) {
        // IndexedDB may return typed arrays or plain arrays
        const d = raw instanceof Float32Array ? raw : new Float32Array(raw);
        const dist = faceapi.euclideanDistance(descriptor, d);
        if (dist < bestDist) {
          bestDist   = dist;
          bestPerson = person;
        }
      }
    }
    if (bestDist < threshold) return { person: bestPerson, distance: bestDist };
    return null;
  }

  /* ----------------------------------------------------------
     cropFace(imgEl, detection, size) → Blob (JPEG)
     Pads around the bounding box for a better thumbnail.
  ---------------------------------------------------------- */
  async function cropFace(imgEl, detection, size = 128) {
    const b   = detection.detection.box;
    const pad = 0.28;

    const srcX = Math.max(0, b.x      - b.width  * pad);
    const srcY = Math.max(0, b.y      - b.height * pad);
    const srcW = Math.min(imgEl.naturalWidth  - srcX, b.width  * (1 + 2 * pad));
    const srcH = Math.min(imgEl.naturalHeight - srcY, b.height * (1 + 2 * pad));

    const c   = document.createElement('canvas');
    c.width   = size;
    c.height  = size;
    c.getContext('2d').drawImage(imgEl, srcX, srcY, srcW, srcH, 0, 0, size, size);
    return new Promise(resolve => c.toBlob(resolve, 'image/jpeg', 0.88));
  }

  return {
    loadModels,
    detectFaces,
    matchFace,
    cropFace,
    get loaded() { return modelsLoaded; },
  };
})();
