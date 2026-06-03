/* ─── Config ────────────────────────────────────────────────── */

const CONFIG = {
  captureIntervalMs: 2500,
  blurThreshold: 80,
  blurSampleWidth: 160,
  blurSampleHeight: 120,
  captureQuality: 0.88,
  confidenceThreshold: 0.15,
};

const AI_BASE = 'https://proxy-api-ia.public.production.lb1.yes.network';

/* ─── Mock ───────────────────────────────────────────────────── */

const MOCK_SKUS = [
  { skus: ['04260FBA106'], features: 'FREEZER_ELECTROLUX_BRANCO_165CM' },
  { skus: ['06501FBA106', '06501FBA206'], features: 'FREEZER_ELECTROLUX_BRANCO_90CM' },
  { skus: ['DFX41BBBNA'], features: 'GELADEIRA_BRASTEMP_FROST_FREE_419L' },
  { skus: ['BRM54HKBNA', 'BRM54AKBNA'], features: 'GELADEIRA_BRASTEMP_FROST_FREE_375L' },
  { skus: ['RE80NAMMGH'], features: 'AR_CONDICIONADO_SAMSUNG_WIND_FREE_9000BTU' },
  { skus: ['WF5000HAWA', 'WF5000HAWABAZ'], features: 'MAQUINA_LAVAR_SAMSUNG_11KG' },
];

const MOCK_COLORS   = ['BRANCO', 'PRETO', 'INOX', 'TITANIUM'];
const MOCK_BRANDS   = ['ELECTROLUX', 'BRASTEMP', 'SAMSUNG', 'LG', 'CONSUL'];
const MOCK_PRODUCTS = ['GELADEIRA', 'FREEZER', 'MICRO-ONDAS', 'AR-CONDICIONADO', 'MAQUINA-LAVAR'];

function rnd(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function mockResponse(_real) {
  const c1idx = Math.floor(Math.random() * MOCK_SKUS.length);
  let c2idx   = (c1idx + 1 + Math.floor(Math.random() * (MOCK_SKUS.length - 1))) % MOCK_SKUS.length;

  const conf1 = parseFloat(rnd(0.10, 0.95).toFixed(3));
  const conf2 = parseFloat(rnd(0.05, conf1 * 0.8).toFixed(3));

  return {
    status: 200,
    message: 'success (mock)',
    data: {
      image_features: {
        color_cls:        { color_index: 0,  color: pick(MOCK_COLORS),   confidence: parseFloat(rnd(0.2, 0.99).toFixed(3)) },
        brand_cls:        { brand_index: 0,  brand: pick(MOCK_BRANDS),   confidence: parseFloat(rnd(0.2, 0.99).toFixed(3)) },
        product_type_cls: { product_type_index: 0, product_type: pick(MOCK_PRODUCTS), confidence: parseFloat(rnd(0.2, 0.99).toFixed(3)) },
      },
      sku_candidates: [
        { rank: 1, super_class: c1idx, agregated_features: MOCK_SKUS[c1idx].features, skus: MOCK_SKUS[c1idx].skus, confidence: conf1 },
        { rank: 2, super_class: c2idx, agregated_features: MOCK_SKUS[c2idx].features, skus: MOCK_SKUS[c2idx].skus, confidence: conf2 },
      ],
    },
  };
}

/* ─── Helpers ───────────────────────────────────────────────── */

function normalizeSkus(skus) {
  if (Array.isArray(skus)) return skus.map(s => String(s).trim()).filter(Boolean).join('\n');
  if (typeof skus === 'string') return skus.trim();
  return '';
}

/* ─── State ─────────────────────────────────────────────────── */

let currentMode     = 'sku';
let isProcessing    = false;
let detectionPaused = false;   // true while result modal is open
let captureTimer    = null;
let stream          = null;
let debugEnabled    = false;
let mockEnabled     = false;
let debugEntryCount = 0;
let debugLog        = [];   // mirrors DOM entries, newest first: [{ts, endpoint, latencyMs, response, thumbBlob}]

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
    if (mockEnabled) response = mockResponse(response);
    const latencyMs = Date.now() - t0;

    if (debugEnabled) {
      const thumb = await blobToThumb(blob);
      addDebugLog({ ts: new Date(), endpoint: apiEndpoint(), latencyMs, thumb, response });
    }

    handleResponse(response);
  } catch (err) {
    console.error('Analysis failed:', err);
    setStatus('Erro na análise', 'error');
    if (debugEnabled && blob) {
      const thumb = await blobToThumb(blob);
      addDebugLog({ ts: new Date(), endpoint: apiEndpoint(), latencyMs: Date.now() - t0, thumb, response: { error: err.message } });
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

  const candidates = payload.data.sku_candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    setStatus('Nenhum SKU identificado', 'ready');
    return;
  }

  const groups = [];
  for (const candidate of candidates) {
    if (candidate.confidence < CONFIG.confidenceThreshold) continue;
    const skus = (candidate.skus || [])
      .map(s => String(s).trim())
      .filter(s => s && s.toLowerCase() !== 'unknown');
    if (skus.length > 0) groups.push({ rank: candidate.rank, confidence: candidate.confidence, skus });
  }

  if (groups.length === 0) {
    setStatus('Nenhum SKU identificado', 'ready');
    return;
  }

  showResultModal(groups, payload.data);
}

/* ─── Frame capture ──────────────────────────────────────────── */

function captureFrame() {
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', CONFIG.captureQuality));
}

function apiEndpoint() {
  if (currentMode === 'sku')    return `${AI_BASE}/api/v1/skuclassification/pipeline/extended`;
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

function showResultModal(groups, fullData) {
  detectionPaused = true;
  setStatus('SKU identificado', 'ready');

  resultSkuValue.innerHTML = groups.map((g, i) => {
    const divider = i > 0 ? '<div class="sku-group-divider"></div>' : '';
    const lines = g.skus.map(sku =>
      `<span class="sku-result-line">` +
        `<span class="sku-text">${escHtml(sku)}</span>` +
        `<span class="sku-conf">${(g.confidence * 100).toFixed(1)}%</span>` +
      `</span>`
    ).join('');
    return divider + lines;
  }).join('');

  resultConfBadge.textContent = '';

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

document.getElementById('debug-mock').addEventListener('change', function () {
  mockEnabled = this.checked;
});

const thresholdSlider = document.getElementById('debug-threshold');
const thresholdLabel  = document.getElementById('debug-threshold-value');
thresholdSlider.addEventListener('input', () => {
  CONFIG.confidenceThreshold = thresholdSlider.valueAsNumber / 100;
  thresholdLabel.textContent = `${thresholdSlider.value}%`;
});

document.getElementById('debug-clear').addEventListener('click', () => {
  debugLogList.querySelectorAll('img.debug-thumb[data-blob]').forEach(img => {
    URL.revokeObjectURL(img.src);
  });
  debugLogList.innerHTML = '<p class="debug-empty">Sem registros</p>';
  debugEntryCount = 0;
  debugLog = [];
});

document.getElementById('debug-export').addEventListener('click', exportDebugLog);

async function exportDebugLog() {
  if (!debugLog.length) { alert('Sem registros no log para exportar.'); return; }

  const btn = document.getElementById('debug-export');
  btn.disabled = true;
  btn.textContent = 'Exportando...';

  try {
    const zip = new JSZip();
    const imgFolder = zip.folder('images');

    const chronological = [...debugLog].reverse(); // oldest first

    const rows = [['#', 'timestamp', 'endpoint', 'latency_ms', 'confidence', 'passed', 'skus', 'image_file', 'full_response']];
    chronological.forEach((entry, i) => {
      const n = i + 1;
      const imgFilename = `frame_${String(n).padStart(3, '0')}.jpg`;
      if (entry.thumbBlob) imgFolder.file(imgFilename, entry.thumbBlob);

      const cands = entry.response?.data?.sku_candidates;
      const conf = Array.isArray(cands) && cands.length > 0 ? cands[0].confidence : undefined;
      const confPct = typeof conf === 'number' ? `${(conf * 100).toFixed(1)}%` : '';
      const passed = Array.isArray(cands) && cands.some(c =>
        c.confidence >= CONFIG.confidenceThreshold &&
        (c.skus || []).some(s => String(s).toLowerCase() !== 'unknown'));
      const skusStr = (cands || [])
        .filter(c => c.confidence >= CONFIG.confidenceThreshold)
        .flatMap(c => (c.skus || []).map(s => `${s}(${(c.confidence * 100).toFixed(1)}%)`))
        .join(', ');

      rows.push([
        n,
        formatTs(entry.ts),
        entry.endpoint,
        entry.latencyMs,
        confPct,
        passed ? 'sim' : 'nao',
        skusStr,
        entry.thumbBlob ? `images/${imgFilename}` : '',
        JSON.stringify(entry.response),
      ]);
    });

    zip.file('log.csv', rows.map(r => r.map(c => csvCell(String(c ?? ''))).join(',')).join('\r\n'));

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `sku-log-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Exportar Log';
  }
}

function csvCell(val) {
  return /[,"\n\r]/.test(val) ? '"' + val.replace(/"/g, '""') + '"' : val;
}

// Called immediately after each request — builds one DOM node and prepends it.
// Opening the panel is instant because the DOM is already built.
function addDebugLog({ ts, endpoint, latencyMs, thumb, response }) {
  debugLog.unshift({ ts, endpoint, latencyMs, response, thumbBlob: thumb.blob ?? null });
  debugEntryCount++;
  if (debugEntryCount > 50) pruneOldestDebugEntry();

  // Remove empty-state placeholder if present
  const empty = debugLogList.querySelector('.debug-empty');
  if (empty) empty.remove();

  const cands  = response?.data?.sku_candidates;
  const conf   = Array.isArray(cands) && cands.length > 0 ? cands[0].confidence : null;
  const confPct = typeof conf === 'number' ? `${(conf * 100).toFixed(1)}%` : '—';
  const passed  = Array.isArray(cands) && cands.some(c =>
    c.confidence >= CONFIG.confidenceThreshold &&
    (c.skus || []).some(s => String(s).toLowerCase() !== 'unknown'));

  const el = document.createElement('div');
  el.className = 'debug-entry';
  // Explicit width/height on <img> so browser never needs to guess intrinsic size
  el.innerHTML = `
    <img class="debug-thumb" data-blob
         src="${thumb.url || ''}"
         width="${thumb.w}" height="${thumb.h}"
         alt="frame">
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
  debugLog.pop();
}

/* ─── Debug thumbnail ─────────────────────────────────────────── */

// Returns {url, w, h} — explicit display dimensions so <img> never guesses.
async function blobToThumb(blob) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const MAX_PX = 144;   // canvas resolution
      const DISP   = 72;    // max display size (css px)
      const ratio  = img.naturalWidth / img.naturalHeight;
      // canvas dimensions preserve aspect ratio
      const cw = ratio >= 1 ? MAX_PX : Math.round(MAX_PX * ratio);
      const ch = ratio >= 1 ? Math.round(MAX_PX / ratio) : MAX_PX;
      const tc = document.createElement('canvas');
      tc.width = cw; tc.height = ch;
      tc.getContext('2d').drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(url);
      // display dimensions (scale down to DISP on the longer side)
      const scale = DISP / Math.max(cw, ch);
      const dw = Math.round(cw * scale);
      const dh = Math.round(ch * scale);
      tc.toBlob(b => resolve({ url: URL.createObjectURL(b), blob: b, w: dw, h: dh }), 'image/jpeg', 0.7);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ url: '', w: 72, h: 54 }); };
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
