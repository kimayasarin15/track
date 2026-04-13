// ─── STATE ────────────────────────────────────────────────────────────────────
const MAX_LAYERS = 6;
const FPS = 30;

let layers = [
  { shape: null, animation: null },
];
let activeLayer = 0;
let currentTool = 'rect';
let currentColor = '#ff4136';

// Interaction modes: 'draw' | 'record'
let appMode = 'draw';

// Draw state
let isDrawing = false;
let drawStart = null; // {x, y} in canvas pixels

// Record state
let isRecording = false;
let isPlaying = false;
let recordedPath = [];
let recordStartTime = null;
let recordDuration = 5;
let playbackStart = null;
let playbackRAF = null;
let recTimerInterval = null;
let scrubbing = false;
let playheadPct = 0;

// ─── CANVAS SETUP ─────────────────────────────────────────────────────────────
const canvasArea = document.getElementById('canvas-area');
const canvas = document.getElementById('main-canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const r = canvasArea.getBoundingClientRect();
  canvas.width = r.width;
  canvas.height = r.height;
  drawFrame(playheadPct);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── SHAPE MODEL ─────────────────────────────────────────────────────────────
// Shapes store geometry explicitly rather than just a centre + size.
// rect:   { type, color, x1, y1, x2, y2 }   (normalised 0-1 coords)
// circle: { type, color, cx, cy, r }         (normalised)
// line:   { type, color, x1, y1, x2, y2 }   (normalised)

function shapeCentre(shape) {
  if (shape.type === 'circle') return { x: shape.cx, y: shape.cy };
  return { x: (shape.x1 + shape.x2) / 2, y: (shape.y1 + shape.y2) / 2 };
}

function drawShapeCtx(offCtx, shape, W, H, dx, dy) {
  offCtx.save();
  offCtx.fillStyle = shape.color;
  offCtx.strokeStyle = shape.color;

  if (shape.type === 'rect') {
    const px1 = shape.x1 * W + dx, py1 = shape.y1 * H + dy;
    const px2 = shape.x2 * W + dx, py2 = shape.y2 * H + dy;
    offCtx.fillRect(
      Math.min(px1, px2), Math.min(py1, py2),
      Math.abs(px2 - px1), Math.abs(py2 - py1)
    );
  } else if (shape.type === 'circle') {
    const px = shape.cx * W + dx, py = shape.cy * H + dy;
    const pr = shape.r * Math.min(W, H);
    offCtx.beginPath();
    offCtx.arc(px, py, pr, 0, Math.PI * 2);
    offCtx.fill();
  } else if (shape.type === 'line') {
    const px1 = shape.x1 * W + dx, py1 = shape.y1 * H + dy;
    const px2 = shape.x2 * W + dx, py2 = shape.y2 * H + dy;
    const len = Math.hypot(px2 - px1, py2 - py1);
    offCtx.lineWidth = Math.max(3, len * 0.04);
    offCtx.lineCap = 'round';
    offCtx.beginPath();
    offCtx.moveTo(px1, py1);
    offCtx.lineTo(px2, py2);
    offCtx.stroke();
  }
  offCtx.restore();
}

function drawShape(shape, dx, dy) {
  drawShapeCtx(ctx, shape, canvas.width, canvas.height, dx, dy);
}

function drawGhost(shape) {
  ctx.save();
  ctx.globalAlpha = 0.5;
  drawShape(shape, 0, 0);
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = '#4a6cf7';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  if (shape.type === 'rect' || shape.type === 'line') {
    const x1 = shape.x1 * canvas.width, y1 = shape.y1 * canvas.height;
    const x2 = shape.x2 * canvas.width, y2 = shape.y2 * canvas.height;
    ctx.strokeRect(
      Math.min(x1,x2)-2, Math.min(y1,y2)-2,
      Math.abs(x2-x1)+4, Math.abs(y2-y1)+4
    );
  } else if (shape.type === 'circle') {
    const px = shape.cx * canvas.width, py = shape.cy * canvas.height;
    const pr = shape.r * Math.min(canvas.width, canvas.height);
    ctx.beginPath();
    ctx.arc(px, py, pr + 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function getPositionAtTime(anim, t) {
  if (!anim || anim.length === 0) return null;
  const dur = anim[anim.length-1].t;
  if (dur === 0) return { x: anim[0].x, y: anim[0].y };
  const clampedT = Math.min(t, dur);
  for (let i = 1; i < anim.length; i++) {
    if (clampedT <= anim[i].t) {
      const prev = anim[i-1], next = anim[i];
      const seg = next.t - prev.t;
      const alpha = seg === 0 ? 1 : (clampedT - prev.t) / seg;
      return {
        x: prev.x + (next.x - prev.x) * alpha,
        y: prev.y + (next.y - prev.y) * alpha,
      };
    }
  }
  return { x: anim[anim.length-1].x, y: anim[anim.length-1].y };
}

function drawFrame(pct) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const t = pct * recordDuration;

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer.shape) continue;

    let dx = 0, dy = 0;
    if (layer.animation && layer.animation.length > 0) {
      const centre = shapeCentre(layer.shape);
      const pos = getPositionAtTime(layer.animation, t);
      if (!pos) continue;
      dx = (pos.x - centre.x) * canvas.width;
      dy = (pos.y - centre.y) * canvas.height;
    }
    drawShape(layer.shape, dx, dy);
  }
}

// ─── TOOL SELECTION ───────────────────────────────────────────────────────────
document.querySelectorAll('.tool-btn[id^="tool-"]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isRecording || isDrawing) return;
    document.querySelectorAll('.tool-btn[id^="tool-"]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.id.replace('tool-', '');
    updateCursor();
  });
});

const colorInput = document.getElementById('color-input');
const colorPreview = document.getElementById('color-preview');
colorInput.addEventListener('input', e => {
  currentColor = e.target.value;
  colorPreview.style.background = currentColor;
});

function updateCursor() {
  canvas.style.cursor = appMode === 'draw' ? 'crosshair' : 'default';
}

// ─── MODE SWITCHING ───────────────────────────────────────────────────────────
const btnDraw   = document.getElementById('btn-draw');
const btnRecord = document.getElementById('btn-record');

btnDraw.addEventListener('click', () => {
  if (isRecording || isDrawing || isPlaying) return;
  setAppMode('draw');
});

btnRecord.addEventListener('click', () => {
  if (isRecording || isDrawing || isPlaying) return;
  setAppMode('record');
});

function setAppMode(mode) {
  appMode = mode;
  // Active / inactive states
  btnDraw.classList.toggle('active', mode === 'draw');
  btnRecord.classList.toggle('active', mode === 'record');
  if (mode === 'draw') {
    setStatus('Draw mode — drag on the canvas to place a shape, or click an existing shape to edit it');
  } else {
    setStatus('Record mode — click a shape to edit it, or press REC to record motion');
  }
  updateCursor();
}

// ─── LAYER TABS ───────────────────────────────────────────────────────────────
// Returns a short display label for a layer, e.g. "CIRCLE 1", "RECT 2", "LINE 3"
function layerLabel(idx) {
  const shape = layers[idx] && layers[idx].shape;
  const typeName = shape ? shape.type.toUpperCase() : 'EMPTY';
  return `${typeName} ${idx + 1}`;
}

function updateLayerTabs() {
  document.querySelectorAll('.layer-tab').forEach((tab, i) => {
    const layer = layers[i];
    tab.classList.remove('active', 'has-shape', 'has-animation');
    if (i === activeLayer) tab.classList.add('active');
    if (layer && layer.animation) tab.classList.add('has-animation');
    else if (layer && layer.shape) tab.classList.add('has-shape');
    // Update label to reflect current shape type
    tab.textContent = layerLabel(i);
  });
}

document.querySelectorAll('.layer-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (isRecording || isDrawing) return;
    activeLayer = parseInt(tab.dataset.layer);
    updateLayerTabs();
    setStatus(`${layerLabel(activeLayer)} selected.`);
  });
});

document.getElementById('add-layer-btn').addEventListener('click', () => {
  if (layers.length >= MAX_LAYERS) return;
  layers.push({ shape: null, animation: null });
  const idx = layers.length - 1;
  const row = document.getElementById('layer-row');
  const addBtn = document.getElementById('add-layer-btn');
  const tab = document.createElement('button');
  tab.className = 'layer-tab';
  tab.dataset.layer = idx;
  tab.textContent = layerLabel(idx);
  tab.addEventListener('click', () => {
    if (isRecording || isDrawing) return;
    activeLayer = idx;
    updateLayerTabs();
    setStatus(`${layerLabel(idx)} selected.`);
  });
  row.insertBefore(tab, addBtn);
  activeLayer = idx;
  updateLayerTabs();
});

// ─── SHAPE HIT TEST ───────────────────────────────────────────────────────────
function hitTestShape(shape, px, py) {
  if (!shape) return false;
  const W = canvas.width, H = canvas.height;
  if (shape.type === 'rect') {
    return px >= Math.min(shape.x1, shape.x2) && px <= Math.max(shape.x1, shape.x2) &&
           py >= Math.min(shape.y1, shape.y2) && py <= Math.max(shape.y1, shape.y2);
  } else if (shape.type === 'circle') {
    const dx = (px - shape.cx) * W, dy = (py - shape.cy) * H;
    return Math.hypot(dx, dy) <= shape.r * Math.min(W, H);
  } else if (shape.type === 'line') {
    const x1 = shape.x1*W, y1 = shape.y1*H, x2 = shape.x2*W, y2 = shape.y2*H;
    const mx = px*W, my = py*H;
    const len2 = (x2-x1)**2 + (y2-y1)**2;
    if (len2 === 0) return Math.hypot(mx-x1, my-y1) < 12;
    const t = Math.max(0, Math.min(1, ((mx-x1)*(x2-x1)+(my-y1)*(y2-y1)) / len2));
    return Math.hypot(mx-(x1+t*(x2-x1)), my-(y1+t*(y2-y1))) < 12;
  }
  return false;
}

// ─── SHAPE INSPECTOR ─────────────────────────────────────────────────────────
const inspector    = document.getElementById('inspector');
const inspColor    = document.getElementById('insp-color');
const inspColorPrev= document.getElementById('insp-color-preview');
const inspSize     = document.getElementById('insp-size');
const inspSizeVal  = document.getElementById('insp-size-val');
let   inspecting   = false;

function openInspector(shape, anchorX, anchorY) {
  inspecting = true;
  inspColor.value = shape.color;
  inspColorPrev.style.background = shape.color;

  if (shape.scale == null) shape.scale = 1.0;
  const pct = Math.round(shape.scale * 100);
  inspSize.value = pct;
  inspSizeVal.textContent = pct + '%';

  // Position near click. anchorX/Y are relative to canvas-area,
  // which is the inspector's offset parent (position:relative).
  const iW = 236, iH = 180;
  const areaW = canvasArea.clientWidth, areaH = canvasArea.clientHeight;
  let left = anchorX + 12;
  let top  = anchorY - 20;
  if (left + iW > areaW)  left = anchorX - iW - 12;
  if (top  + iH > areaH) top  = areaH - iH - 8;
  if (top  < 4)  top  = 4;
  if (left < 4)  left = 4;
  inspector.style.left = left + 'px';
  inspector.style.top  = top  + 'px';
  inspector.classList.add('visible');
}

function closeInspector() {
  inspector.classList.remove('visible');
  inspecting = false;
  drawFrame(playheadPct);
}

inspColor.addEventListener('input', e => {
  const layer = layers[activeLayer];
  if (!layer.shape) return;
  layer.shape.color = e.target.value;
  inspColorPrev.style.background = e.target.value;
  drawFrame(playheadPct);
});

inspSize.addEventListener('input', e => {
  const layer = layers[activeLayer];
  if (!layer.shape) return;
  const scale = parseInt(e.target.value) / 100;
  inspSizeVal.textContent = e.target.value + '%';
  applyScale(layer.shape, scale);
  drawFrame(playheadPct);
});

document.getElementById('insp-close').addEventListener('click', closeInspector);

function applyScale(shape, newScale) {
  if (shape.scale == null) shape.scale = 1.0;
  const ratio = newScale / shape.scale;
  shape.scale = newScale;
  if (shape.type === 'rect') {
    const cx = (shape.x1 + shape.x2) / 2, cy = (shape.y1 + shape.y2) / 2;
    const hw = (shape.x2 - shape.x1) / 2 * ratio;
    const hh = (shape.y2 - shape.y1) / 2 * ratio;
    shape.x1 = cx - hw; shape.x2 = cx + hw;
    shape.y1 = cy - hh; shape.y2 = cy + hh;
  } else if (shape.type === 'circle') {
    shape.r *= ratio;
  } else if (shape.type === 'line') {
    const cx = (shape.x1 + shape.x2) / 2, cy = (shape.y1 + shape.y2) / 2;
    const dx1 = (shape.x1 - cx) * ratio, dy1 = (shape.y1 - cy) * ratio;
    const dx2 = (shape.x2 - cx) * ratio, dy2 = (shape.y2 - cy) * ratio;
    shape.x1 = cx + dx1; shape.y1 = cy + dy1;
    shape.x2 = cx + dx2; shape.y2 = cy + dy2;
  }
}

// Close inspector when clicking outside it (canvas clicks handled separately below)
document.addEventListener('mousedown', e => {
  if (inspecting && !inspector.contains(e.target) && e.target !== canvas) {
    closeInspector();
  }
});

// ─── DRAW ON CANVAS ───────────────────────────────────────────────────────────
function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / canvas.width,
    y: (e.clientY - r.top)  / canvas.height,
  };
}

function buildShapeFromDrag(start, end) {
  const minW = 8 / canvas.width, minH = 8 / canvas.height;
  if (currentTool === 'rect') {
    return { type: 'rect', color: currentColor,
      x1: Math.min(start.x, end.x), y1: Math.min(start.y, end.y),
      x2: Math.max(start.x, end.x) || start.x + minW,
      y2: Math.max(start.y, end.y) || start.y + minH,
    };
  } else if (currentTool === 'circle') {
    const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2;
    const r = Math.max(
      Math.hypot(end.x - start.x, end.y - start.y) / 2,
      4 / Math.min(canvas.width, canvas.height)
    );
    return { type: 'circle', color: currentColor, cx, cy, r };
  } else if (currentTool === 'line') {
    return { type: 'line', color: currentColor,
      x1: start.x, y1: start.y, x2: end.x, y2: end.y,
    };
  }
}

canvas.addEventListener('mousedown', e => {
  if (isRecording || isPlaying) return;

  const pos = canvasPos(e);

  // ── Shape click → open inspector (works in BOTH draw and record mode) ──
  // This check comes BEFORE the mode guard so you can always click a shape
  // to edit it, regardless of which mode you're in.
  const layer = layers[activeLayer];
  if (!isDrawing && layer.shape && hitTestShape(layer.shape, pos.x, pos.y)) {
    const r = canvas.getBoundingClientRect();
    // Coordinates relative to canvas-area (inspector's offset parent)
    openInspector(layer.shape, e.clientX - r.left, e.clientY - r.top);
    return;
  }

  // ── Only start a new drawing stroke in draw mode ──
  if (appMode !== 'draw') return;

  if (inspecting) { closeInspector(); return; }
  isDrawing = true;
  drawStart = pos;
});

canvas.addEventListener('mousemove', e => {
  // ── Hover cursor: show pointer when hovering over a clickable shape ──
  if (!isDrawing && !isRecording && !isPlaying) {
    const hPos = canvasPos(e);
    const hLayer = layers[activeLayer];
    if (hLayer.shape && hitTestShape(hLayer.shape, hPos.x, hPos.y)) {
      canvas.style.cursor = 'pointer';
    } else {
      updateCursor();
    }
  }

  if (appMode === 'draw' && isDrawing && drawStart) {
    const cur = canvasPos(e);
    const ghost = buildShapeFromDrag(drawStart, cur);
    drawFrame(playheadPct);
    if (ghost) drawGhost(ghost);
    return;
  }

  // recording path capture
  if (appMode === 'record' && isRecording) {
    const r = canvas.getBoundingClientRect();
    let x = (e.clientX - r.left) / canvas.width;
    let y = (e.clientY - r.top)  / canvas.height;

    if (e.shiftKey && recordedPath.length > 0) {
      const origin = recordedPath[0];
      const dx = Math.abs(x - origin.x);
      const dy = Math.abs(y - origin.y);
      if (dx >= dy) y = origin.y;
      else          x = origin.x;
    }

    const t = performance.now();
    if (!recordStartTime) recordStartTime = t;
    const elapsed = (t - recordStartTime) / 1000;
    recordedPath.push({ t: elapsed, x, y });

    drawFrame(0);
    const layer = layers[activeLayer];
    if (layer.shape) {
      const centre = shapeCentre(layer.shape);
      const dx = (x - centre.x) * canvas.width;
      const dy = (y - centre.y) * canvas.height;
      drawShape(layer.shape, dx, dy);
    }
    if (recordedPath.length > 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(74,108,247,0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      recordedPath.forEach((p, i) => {
        const px = p.x * canvas.width, py = p.y * canvas.height;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.restore();
    }
    if (elapsed >= recordDuration) stopRecording();
  }
});

canvas.addEventListener('mouseup', e => {
  if (appMode !== 'draw' || !isDrawing || !drawStart) return;
  isDrawing = false;
  const end = canvasPos(e);
  const shape = buildShapeFromDrag(drawStart, end);
  drawStart = null;
  if (!shape) return;

  const tooSmall = (shape.type === 'circle' && shape.r * Math.min(canvas.width, canvas.height) < 4) ||
                   (shape.type !== 'circle' && Math.abs(shape.x2 - shape.x1) * canvas.width < 4 &&
                    Math.abs(shape.y2 - shape.y1) * canvas.height < 4);
  if (tooSmall) { drawFrame(playheadPct); return; }

  layers[activeLayer].shape = shape;
  layers[activeLayer].animation = null;
  updateLayerTabs();
  drawFrame(playheadPct);
  checkExportReady();

  setAppMode('record');
  setStatus(`${layerLabel(activeLayer)} drawn. Click it to change colour or size, or press REC to record motion.`);
});

canvas.addEventListener('mouseleave', e => {
  if (isDrawing) {
    isDrawing = false;
    const end = canvasPos(e);
    const shape = buildShapeFromDrag(drawStart || end, end);
    drawStart = null;
    if (shape) {
      layers[activeLayer].shape = shape;
      layers[activeLayer].animation = null;
      updateLayerTabs();
      checkExportReady();
      setAppMode('record');
    }
    drawFrame(playheadPct);
  }
  if (appMode === 'record' && isRecording && recordedPath.length > 5) stopRecording();
  updateCursor();
});

// ─── RECORDING ────────────────────────────────────────────────────────────────
const recBtn = document.getElementById('rec-btn');
const recOverlay = document.getElementById('rec-overlay');
const recTimerEl = document.getElementById('rec-timer');

recBtn.addEventListener('click', () => {
  if (isPlaying || isDrawing) return;
  if (!layers[activeLayer].shape) {
    setStatus('Draw a shape on this layer first!');
    setAppMode('draw');
    return;
  }
  if (isRecording) stopRecording();
  else startRecording();
});

function startRecording() {
  isRecording = true;
  recordedPath = [];
  recordStartTime = null;
  recordDuration = parseInt(document.getElementById('duration-select').value);
  recBtn.classList.add('recording');
  recOverlay.classList.add('visible');
  setAppMode('record');
  setStatus('Recording… move your mouse over the canvas.');
  canvas.style.cursor = 'none';

  recTimerInterval = setInterval(() => {
    if (!recordStartTime) return;
    const elapsed = (performance.now() - recordStartTime) / 1000;
    recTimerEl.textContent = elapsed.toFixed(1) + 's';
    if (elapsed >= recordDuration) stopRecording();
  }, 50);
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  clearInterval(recTimerInterval);
  recBtn.classList.remove('recording');
  recOverlay.classList.remove('visible');
  canvas.style.cursor = 'crosshair';

  if (recordedPath.length > 1) {
    const t0 = recordedPath[0].t;
    const tEnd = recordedPath[recordedPath.length-1].t - t0;
    const dur = tEnd > 0 ? tEnd : 1;
    const norm = recordedPath.map(p => ({
      t: (p.t - t0) / dur * recordDuration,
      x: p.x, y: p.y,
    }));
    layers[activeLayer].animation = norm;
    updateLayerTabs();
    setStatus(`Motion recorded! ${recordedPath.length} pts · ${recordDuration}s. Press ▶ to play.`);
    checkExportReady();
    setPlayhead(0);
    drawFrame(0);
  } else {
    setStatus('Recording too short — try again.');
  }
}

// ─── PLAYBACK ─────────────────────────────────────────────────────────────────
const playBtn = document.getElementById('play-btn');
const stopBtn = document.getElementById('stop-btn');

playBtn.addEventListener('click', () => {
  if (isRecording) return;
  if (isPlaying) { pausePlayback(); return; }
  startPlayback();
});

stopBtn.addEventListener('click', () => {
  stopPlayback();
});

function startPlayback() {
  const hasAny = layers.some(l => l.animation);
  if (!hasAny) { setStatus('No animations recorded yet.'); return; }
  isPlaying = true;
  recordDuration = parseInt(document.getElementById('duration-select').value);
  playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <rect x="2" y="1" width="4" height="12" rx="1" fill="#ccc"/>
    <rect x="8" y="1" width="4" height="12" rx="1" fill="#ccc"/>
  </svg>`;
  playbackStart = performance.now() - playheadPct * recordDuration * 1000;

  function tick(now) {
    if (!isPlaying) return;
    const elapsed = (now - playbackStart) / 1000;
    const pct = Math.min(elapsed / recordDuration, 1);
    setPlayhead(pct);
    drawFrame(pct);
    if (pct >= 1) { stopPlayback(); return; }
    playbackRAF = requestAnimationFrame(tick);
  }
  playbackRAF = requestAnimationFrame(tick);
}

function pausePlayback() {
  isPlaying = false;
  cancelAnimationFrame(playbackRAF);
  playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,1 13,7 3,13" fill="#ccc"/></svg>`;
}

function stopPlayback() {
  isPlaying = false;
  cancelAnimationFrame(playbackRAF);
  playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,1 13,7 3,13" fill="#ccc"/></svg>`;
  setPlayhead(0);
  drawFrame(0);
}

// ─── TIMELINE SCRUB ───────────────────────────────────────────────────────────
const timelineTrack = document.getElementById('timeline-track');
const timelineFilled = document.getElementById('timeline-filled');
const timelineHead = document.getElementById('timeline-head');
const timeEnd = document.getElementById('time-end');

function setPlayhead(pct) {
  playheadPct = pct;
  timelineFilled.style.width = (pct * 100) + '%';
  timelineHead.style.left = (pct * 100) + '%';
  const secs = Math.round(pct * recordDuration);
  const m = String(Math.floor(secs/60)).padStart(2,'0');
  const s = String(secs%60).padStart(2,'0');
  document.getElementById('time-start').textContent = `${m}:${s}`;
}

document.getElementById('duration-select').addEventListener('change', e => {
  recordDuration = parseInt(e.target.value);
  const m = String(Math.floor(recordDuration/60)).padStart(2,'0');
  const s = String(recordDuration%60).padStart(2,'0');
  timeEnd.textContent = `${m}:${s}`;
});
timeEnd.textContent = '00:05';

timelineTrack.addEventListener('mousedown', e => {
  if (isRecording) return;
  scrubbing = true;
  pausePlayback();
  doScrub(e);
});
document.addEventListener('mousemove', e => {
  if (!scrubbing) return;
  doScrub(e);
});
document.addEventListener('mouseup', () => { scrubbing = false; });

function doScrub(e) {
  const r = timelineTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  setPlayhead(pct);
  drawFrame(pct);
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

  if (e.key === 'r' || e.key === 'R') recBtn.click();

  // Escape closes the inspector
  if (e.key === 'Escape' && inspecting) {
    closeInspector();
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (isRecording || isPlaying || isDrawing) return;
    const layer = layers[activeLayer];
    if (layer.animation) {
      layer.animation = null;
      updateLayerTabs();
      drawFrame(playheadPct);
      checkExportReady();
      setStatus(`Animation cleared from Layer ${activeLayer + 1}. Press Delete again to remove the shape.`);
    } else if (layer.shape) {
      layer.shape = null;
      updateLayerTabs();
      drawFrame(playheadPct);
      checkExportReady();
      setStatus(`Layer ${activeLayer + 1} cleared.`);
      setAppMode('draw');
    }
  }
});

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

// ─── EXPORT MP4 ───────────────────────────────────────────────────────────────
function checkExportReady() {
  const hasAny = layers.some(l => l.animation && l.shape);
  document.getElementById('export-btn').disabled = !hasAny;
}

const exportBtn = document.getElementById('export-btn');
const modal = document.getElementById('modal');
const modalProgress = document.getElementById('modal-progress');
const modalStatus = document.getElementById('modal-status');
let exportCancelled = false;

exportBtn.addEventListener('click', async () => {
  if (exportBtn.disabled) return;
  modal.classList.add('visible');
  exportCancelled = false;
  modalProgress.style.width = '0%';
  modalStatus.textContent = '';

  const W = canvas.width, H = canvas.height;
  const totalFrames = Math.round(recordDuration * FPS);

  const offCanvas = document.createElement('canvas');
  offCanvas.width = W; offCanvas.height = H;
  const offCtx = offCanvas.getContext('2d');

  const stream = offCanvas.captureStream(FPS);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  recorder.start();

  for (let f = 0; f <= totalFrames; f++) {
    if (exportCancelled) { recorder.stop(); modal.classList.remove('visible'); return; }
    const pct = f / totalFrames;
    const t = pct * recordDuration;

    offCtx.clearRect(0, 0, W, H);
    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, W, H);

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer.shape || !layer.animation) continue;
      const centre = shapeCentre(layer.shape);
      const pos = getPositionAtTime(layer.animation, t);
      if (!pos) continue;
      const dx = (pos.x - centre.x) * W;
      const dy = (pos.y - centre.y) * H;
      drawShapeCtx(offCtx, layer.shape, W, H, dx, dy);
    }

    modalProgress.style.width = (pct * 100) + '%';
    modalStatus.textContent = `Frame ${f} / ${totalFrames}`;
    await new Promise(r => setTimeout(r, 1000 / FPS));
  }

  recorder.stop();
  await new Promise(r => recorder.onstop = r);

  if (exportCancelled) { modal.classList.remove('visible'); return; }

  const blob = new Blob(chunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'motion.webm'; a.click();
  URL.revokeObjectURL(url);
  modal.classList.remove('visible');
});

document.getElementById('modal-cancel').addEventListener('click', () => {
  exportCancelled = true;
  modal.classList.remove('visible');
});

// ─── HELP / INFO MODAL ────────────────────────────────────────────────────────
const HELP_STEPS = [
  {
    title: 'Add a shape',
    body: 'Select a shape type (circle, square, or line) from the toolbar and choose a colour. Drag on the canvas to draw it — it will appear on the active layer.',
  },
  {
    title: 'Select your layer',
    body: 'Click a layer tab at the bottom to make it active. Each layer holds one shape and one recorded motion path.',
  },
  {
    title: 'Record',
    body: 'Hit the REC button (or press <strong>R</strong>) to start recording, then move your trackpad or cursor across the canvas. Your movement is captured in real time and stops automatically when the duration runs out.',
  },
  {
    title: 'Playback',
    body: 'Once recording stops, press the <strong>▶ Play</strong> button to watch your shape animate along the recorded path. You can also scrub the timeline to jump to any moment.',
  },
  {
    title: 'Axis lock',
    body: 'Hold <strong>Shift</strong> while recording to snap movement to a single axis — horizontal or vertical — based on whichever direction you move first.',
  },
  {
    title: 'Delete',
    body: 'With a layer selected, press <strong>Delete</strong> to remove its recording while keeping the shape in place. Press <strong>Delete</strong> again (with no recording) to remove the shape entirely.',
  },
  {
    title: 'Export',
    body: 'Once you have at least one animated layer, the <strong>Export MP4</strong> button becomes active. Click it to render and download your animation.',
  },
];

const helpModal   = document.getElementById('help-modal');
const helpStepNum = document.getElementById('help-step-num');
const helpTitle   = document.getElementById('help-title');
const helpBody    = document.getElementById('help-body');
const helpDots    = document.getElementById('help-dots');
const helpNext    = document.getElementById('help-next');
const helpBack    = document.getElementById('help-back');
let helpStep = 0;

// Build dot indicators
HELP_STEPS.forEach((_, i) => {
  const dot = document.createElement('div');
  dot.className = 'help-dot' + (i === 0 ? ' active' : '');
  dot.dataset.step = i;
  helpDots.appendChild(dot);
});

function showHelpStep(idx) {
  helpStep = idx;
  const step = HELP_STEPS[idx];
  helpStepNum.textContent = idx + 1;
  helpTitle.textContent = step.title;
  helpBody.innerHTML = step.body;

  // Update dots
  helpDots.querySelectorAll('.help-dot').forEach((d, i) => {
    d.classList.toggle('active', i === idx);
  });

  // Back disabled on first step
  helpBack.disabled = idx === 0;

  // Last step: change NEXT to DONE
  helpNext.textContent = idx === HELP_STEPS.length - 1 ? 'DONE ✓' : 'NEXT →';
}

function openHelp() {
  showHelpStep(0);
  helpModal.classList.add('visible');
}

function closeHelp() {
  helpModal.classList.remove('visible');
}

document.getElementById('info-btn').addEventListener('click', openHelp);
document.getElementById('help-close').addEventListener('click', closeHelp);

helpBack.addEventListener('click', () => {
  if (helpStep > 0) showHelpStep(helpStep - 1);
});

helpNext.addEventListener('click', () => {
  if (helpStep < HELP_STEPS.length - 1) {
    showHelpStep(helpStep + 1);
  } else {
    closeHelp();
  }
});

// Close on backdrop click
helpModal.addEventListener('mousedown', e => {
  if (e.target === helpModal) closeHelp();
});

// Escape also closes
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && helpModal.classList.contains('visible')) {
    closeHelp();
  }
});
