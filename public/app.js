/* ─── Config ────────────────────────────────────────────────── */

const CONFIG = {
  captureIntervalMs: 2500,
  blurThreshold: 80,
  blurSampleWidth: 160,
  blurSampleHeight: 120,
  captureQuality: 0.88,
  confidenceThreshold: 0.6,
};

const AI_BASE = 'https://ms-ai-services.public.homologation.lb1.yes.network';

/* ─── State ─────────────────────────────────────────────────── */

let currentMode     = 'sku';
let isProcessing    = false;
let detectionPaused = false;   // true while result modal is open
let captureTimer    = null;
let stream          = null;
let debugEnabled    = false;
let debugEntryCount = 0;

/* ─── DOM refs ──────────────────────────────────────────────── */

const video        = document.getElementById('video');
const canvas       = document.getElementById('capture-canvas');
const ctx          = canvas.getContext('2d', { willReadFrequently: true });
const procOverlay  = document.getElementById('processing-overlay');
const procLabel    = document.getElementById('processing-label');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const qualityOpts  = document.getElementById('quality-options');
const productType  = document.getElementById('product-type');

// Result modal
const resultModal       = document.getElementById('result-modal');
const resultSkuValue    = document.getElementById('result-sku-value');
const resultConfBadge   = document.getElementById('result-confidence-badge');

// Info modal
const infoModal    = document.getElementById('info-modal');
const infoBody     = document.getElementById('info-modal-body');

// Debug
const debugIcon    = document.getElementById('debug-icon');
const debugPanel   = document.getElementById('debug-panel');
const debugEnabled_cb = document.getElementById('debug-enabled');
const debugLogList = document.getElementById('debug-log-list');

/* ─── Camera ─────────────────────────────────────────────────── */

function stopStream() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  video.srcObject = null;
}

window.addEventListener('pagehide', stopStream);

async function startCamera() {
  setStatus('Iniciando câmera...', 'working');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });

    await new Promise((resolve, reject) => {
      const tid = setTimeout(() => reject(new Error('camera timeout')), 15000);
      const done = () => { clearTimeout(tid); resolve(); };
      video.addEventListener('loadeddata', done, { once: true });
      video.addEventListener('error', (e) => { clearTimeout(tid); reject(e); }, { once: true });
      video.srcObject = stream;
      video.play().catch(() => {});
      if (video.readyState >= 2) done();
    });

    setStatus('Pronto', 'ready');
    schedulCapture();
  } catch (err) {
    setStatus('Sem acesso à câmera', 'error');
    console.error('Camera error:', err);
  }
}

/* ─── Blur detection (Laplacian variance) ────────────────────── */

const blurCanvas = document.createElement('canvas');
blurCanvas.width  = CONFIG.blurSampleWidth;
blurCanvas.height = CONFIG.blurSampleHeight;
const blurCtx = blurCanvas.getContext('2d', { willReadFrequently: true });

function computeSharpness() {
  blurCtx.drawImage(video, 0, 0, CONFIG.blurSampleWidth, CONFIG.blurSampleHeight);
  const { data } = blurCtx.getImageData(0, 0, CONFIG.blurSampleWidth, CONFIG.blurSampleHeight);
  const W = CONFIG.blurSampleWidth, H = CONFIG.blurSampleHeight;
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    gray[i] = (77 * data[i*4] + 150 * data[i*4+1] + 29 * data[i*4+2]) >> 8;
  }
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const lap = -4*gray[y*W+x] + gray[(y-1)*W+x] + gray[(y+1)*W+x] + gray[y*W+x-1] + gray[y*W+x+1];
      sum += lap; sumSq += lap*lap; n++;
    }
  }
  const mean = sum / n;
  return (sumSq / n) - mean * mean;
}

/* ─── Capture loop ───────────────────────────────────────────── */

function schedulCapture() {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(tryCapture, CONFIG.captureIntervalMs);
}

async function tryCapture() {
  if (isProcessing || detectionPaused) { schedulCapture(); return; }

  if (video.readyState < 2) {
    setStatus('Câmera iniciando...', 'working');
    schedulCapture();
    return;
  }

  const sharpness = computeSharpness();
  if (sharpness < CONFIG.blurThreshold) {
    setStatus('Aguardando foco...', 'blur');
    schedulCapture();
    return;
  }

  await runAnalysis();
  schedulCapture();
}

/* ─── Analysis ───────────────────────────────────────────────── */

async function runAnalysis() {
  if (currentMode === 'quality' && !productType.value) {
    setStatus('Selecione o tipo de produto', 'blur');
    return;
  }

  isProcessing = true;
  setProcessing(true);
  setStatus('Analisando...', 'working');
  procLabel.textContent = 'Analisando...';

  const slowTimer = setTimeout(() => { procLabel.textContent = 'Aguardando resposta...'; }, 5000);

  const t0 = Date.now();
  let blob, response;

  try {
    blob = await captureFrame();
    response = await sendToAPI(blob);
    const latencyMs = Date.now() - t0;

    if (debugEnabled) {
      const thumbUrl = await blobToThumbUrl(blob);
      addDebugLog({ ts: new Date(), endpoint: apiEndpoint(), latencyMs, thumbUrl, response });
    }

    handleResponse(response);
  } catch (err) {
    console.error('Analysis failed:', err);
    setStatus('Erro na análise', 'error');
    if (debugEnabled && blob) {
      const thumbUrl = await blobToThumbUrl(blob);
      addDebugLog({ ts: new Date(), endpoint: apiEndpoint(), latencyMs: Date.now() - t0, thumbUrl, response: { error: err.message } });
    }
  } finally {
    clearTimeout(slowTimer);
    procLabel.textContent = 'Analisando...';
    isProcessing = false;
    setProcessing(false);
  }
}

function handleResponse(payload) {
  if (!payload || payload.status !== 200 || !payload.data) {
    setStatus('Sem resultado', 'ready');
    return;
  }

  const data = payload.data;
  const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
  const skus = typeof data.skus === 'string' ? data.skus.trim() : '';

  // Low confidence OR unknown SKU → silent, keep trying
  if (confidence < CONFIG.confidenceThreshold || !skus || skus.toLowerCase() === 'unknown') {
    setStatus('Nenhum SKU identificado', 'ready');
    return;
  }

  // High confidence + known SKU → show result modal, pause detection
  showResultModal(skus, confidence, data);
}

/* ─── Frame capture ──────────────────────────────────────────── */

function captureFrame() {
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', CONFIG.captureQuality));
}

function apiEndpoint() {
  if (currentMode === 'sku')    return `${AI_BASE}/api/v1/skuclassification/pipeline/`;
  if (currentMode === 'detect') return `${AI_BASE}/api/v1/detection/`;
  const pt = productType.value;
  return `${AI_BASE}/api/v1/defects/pipeline_product_type_quality` + (pt ? `?product_type=${encodeURIComponent(pt)}` : '');
}

async function sendToAPI(blob) {
  const form = new FormData();
  // quality endpoint uses "images" field; all others use "file"
  form.append(currentMode === 'quality' ? 'images' : 'file', blob, 'frame.jpg');

  const res = await fetch(apiEndpoint(), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(50000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();

  // quality returns a flat object — normalise to {status, data} shape
  if (currentMode === 'quality' && json && !('status' in json)) {
    return { status: 200, message: 'success', data: json };
  }
  return json;
}

/* ─── Result modal ───────────────────────────────────────────── */

function showResultModal(sku, confidence, fullData) {
  detectionPaused = true;
  setStatus('SKU identificado', 'ready');

  resultSkuValue.textContent = sku;
  resultConfBadge.textContent = `Confiança: ${(confidence * 100).toFixed(1)}%`;

  // Store full data for "Mais informações"
  resultModal._fullData = fullData;

  resultModal.classList.remove('hidden');
}

function closeResultModal() {
  resultModal.classList.add('hidden');
  infoModal.classList.add('hidden');
  detectionPaused = false;
  setStatus('Pronto', 'ready');
  schedulCapture();
}

document.getElementById('result-modal-close').addEventListener('click', closeResultModal);
document.getElementById('btn-result-close').addEventListener('click', closeResultModal);

document.getElementById('btn-more-info').addEventListener('click', () => {
  const data = resultModal._fullData || {};
  infoBody.innerHTML = buildInfoRows(data);
  infoModal.classList.remove('hidden');
});

document.getElementById('info-modal-close').addEventListener('click', () => {
  infoModal.classList.add('hidden');
});

function buildInfoRows(data, prefix) {
  return Object.entries(data).map(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return buildInfoRows(v, key);
    }
    const display = typeof v === 'number' && v > 0 && v <= 1
      ? `${(v * 100).toFixed(2)}%`
      : escHtml(String(v));
    return `<div class="info-field">
      <span class="info-key">${escHtml(key)}</span>
      <span class="info-val${key.includes('index') ? ' mono' : ''}">${display}</span>
    </div>`;
  }).join('');
}

/* ─── Debug ──────────────────────────────────────────────────── */

debugIcon.addEventListener('click', () => {
  const isOpen = !debugPanel.classList.contains('hidden');
  debugPanel.classList.toggle('hidden', isOpen);
  debugIcon.classList.toggle('active', !isOpen);
});

document.getElementById('debug-panel-close').addEventListener('click', () => {
  debugPanel.classList.add('hidden');
  debugIcon.classList.remove('active');
});

debugEnabled_cb.addEventListener('change', () => {
  debugEnabled = debugEnabled_cb.checked;
});

const thresholdSlider = document.getElementById('debug-threshold');
const thresholdLabel  = document.getElementById('debug-threshold-value');
thresholdSlider.addEventListener('input', () => {
  CONFIG.confidenceThreshold = thresholdSlider.valueAsNumber / 100;
  thresholdLabel.textContent = `${thresholdSlider.value}%`;
});

document.getElementById('debug-clear').addEventListener('click', () => {
  // Revoke all stored blob URLs to free memory before wiping DOM
  debugLogList.querySelectorAll('img.debug-thumb[data-blob]').forEach(img => {
    URL.revokeObjectURL(img.src);
  });
  debugLogList.innerHTML = '<p class="debug-empty">Sem registros</p>';
  debugEntryCount = 0;
});

// Called immediately after each request — builds one DOM node and prepends it.
// Opening the panel is instant because the DOM is already built.
function addDebugLog({ ts, endpoint, latencyMs, thumbUrl, response }) {
  debugEntryCount++;
  if (debugEntryCount > 50) pruneOldestDebugEntry();

  // Remove empty-state placeholder if present
  const empty = debugLogList.querySelector('.debug-empty');
  if (empty) empty.remove();

  const conf   = response?.data?.confidence;
  const confPct = typeof conf === 'number' ? `${(conf * 100).toFixed(1)}%` : '—';
  const passed  = typeof conf === 'number' && conf >= CONFIG.confidenceThreshold
               && response?.data?.skus?.toLowerCase() !== 'unknown';

  const el = document.createElement('div');
  el.className = 'debug-entry';
  el.innerHTML = `
    <img class="debug-thumb" data-blob src="${thumbUrl || ''}" alt="frame">
    <div class="debug-entry-body">
      <div class="debug-meta">
        <span class="debug-ts">${formatTs(ts)}</span>
        <span class="debug-endpoint">${escHtml(endpoint)}</span>
        <span class="debug-latency">${latencyMs}ms</span>
        <span class="debug-confidence ${passed ? 'pass' : 'fail'}">${confPct}</span>
      </div>
      <button class="debug-json-toggle">ver JSON ▾</button>
      <pre class="debug-json-block hidden">${escHtml(JSON.stringify(response, null, 2))}</pre>
    </div>`;

  el.querySelector('.debug-json-toggle').addEventListener('click', function () {
    const pre = this.nextElementSibling;
    const hidden = pre.classList.toggle('hidden');
    this.textContent = hidden ? 'ver JSON ▾' : 'ocultar JSON ▴';
  });

  debugLogList.prepend(el);
}

function pruneOldestDebugEntry() {
  const last = debugLogList.lastElementChild;
  if (!last || last.classList.contains('debug-empty')) return;
  const img = last.querySelector('img.debug-thumb[data-blob]');
  if (img) URL.revokeObjectURL(img.src);
  last.remove();
  debugEntryCount--;
}

/* ─── Debug thumbnail ─────────────────────────────────────────── */

async function blobToThumbUrl(blob) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const tc = document.createElement('canvas');
      tc.width = 128; tc.height = 96;
      tc.getContext('2d').drawImage(img, 0, 0, 128, 96);
      URL.revokeObjectURL(url);
      tc.toBlob(b => resolve(URL.createObjectURL(b)), 'image/jpeg', 0.7);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
    img.src = url;
  });
}

/* ─── Mode tabs ──────────────────────────────────────────────── */

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentMode = tab.dataset.mode;
    qualityOpts.classList.toggle('hidden', currentMode !== 'quality');
  });
});

/* ─── UI helpers ─────────────────────────────────────────────── */

function setStatus(text, state) {
  statusText.textContent = text;
  statusDot.className = state || '';
}

function setProcessing(on) {
  procOverlay.classList.toggle('active', on);
}

function formatTs(d) {
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ─── Boot ───────────────────────────────────────────────────── */

startCamera();
