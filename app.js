// ─── STATE ────────────────────────────────────────────────────────────────────
const MAX_LAYERS = 6;
const FPS = 30;

let layers = [
  { shape: null, animation: null },
  { shape: null, animation: null },
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
// Shapes now store geometry explicitly rather than just a centre + size.
// rect:   { type, color, x1, y1, x2, y2 }   (normalised 0-1 coords)
// circle: { type, color, cx, cy, r }         (normalised)
// line:   { type, color, x1, y1, x2, y2 }   (normalised)
// The pivot point used for animation is the centre of the bounding box.

function shapeCentre(shape) {
  if (shape.type === 'circle') return { x: shape.cx, y: shape.cy };
  return { x: (shape.x1 + shape.x2) / 2, y: (shape.y1 + shape.y2) / 2 };
}

// Draw a shape onto any canvas context, offset by (dx, dy) from its original
// normalised position. dx/dy are pixel deltas.
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

// Convenience wrapper for main canvas
function drawShape(shape, dx, dy) {
  drawShapeCtx(ctx, shape, canvas.width, canvas.height, dx, dy);
}

// Draw ghost preview while dragging
function drawGhost(shape) {
  ctx.save();
  ctx.globalAlpha = 0.5;
  drawShape(shape, 0, 0);
  // dashed bounding box hint
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
      // delta from original centre to animated position
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
const modeToggle = document.getElementById('mode-toggle');
const modeToggleLabel = document.getElementById('mode-toggle-label');

modeToggle.addEventListener('click', () => {
  if (isRecording || isDrawing || isPlaying) return;
  setAppMode(appMode === 'draw' ? 'record' : 'draw');
});

function setAppMode(mode) {
  appMode = mode;
  if (mode === 'draw') {
    modeToggle.classList.remove('record-mode');
    modeToggleLabel.textContent = 'DRAW';
    setStatus('Draw mode — drag on the canvas to place a shape on the active layer');
  } else {
    modeToggle.classList.add('record-mode');
    modeToggleLabel.textContent = 'RECORD';
    setStatus('Record mode — press REC then move your mouse to record motion');
  }
  updateCursor();
}

// ─── LAYER TABS ───────────────────────────────────────────────────────────────
function updateLayerTabs() {
  document.querySelectorAll('.layer-tab').forEach((tab, i) => {
    const layer = layers[i];
    tab.classList.remove('active', 'has-shape', 'has-animation');
    if (i === activeLayer) tab.classList.add('active');
    if (layer && layer.animation) tab.classList.add('has-animation');
    else if (layer && layer.shape) tab.classList.add('has-shape');
  });
}

document.querySelectorAll('.layer-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (isRecording || isDrawing) return;
    activeLayer = parseInt(tab.dataset.layer);
    updateLayerTabs();
    setStatus(`Layer ${activeLayer+1} selected.`);
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
  tab.textContent = `LAYER ${idx+1}`;
  tab.addEventListener('click', () => {
    if (isRecording || isDrawing) return;
    activeLayer = idx;
    updateLayerTabs();
  });
  row.insertBefore(tab, addBtn);
  activeLayer = idx;
  updateLayerTabs();
});

// ─── SHAPE HIT TEST ───────────────────────────────────────────────────────────
function hitTestShape(shape, px, py) {
  // px, py are normalised 0-1 canvas coords
  if (!shape) return false;
  const W = canvas.width, H = canvas.height;
  if (shape.type === 'rect') {
    return px >= Math.min(shape.x1, shape.x2) && px <= Math.max(shape.x1, shape.x2) &&
           py >= Math.min(shape.y1, shape.y2) && py <= Math.max(shape.y1, shape.y2);
  } else if (shape.type === 'circle') {
    const dx = (px - shape.cx) * W, dy = (py - shape.cy) * H;
    return Math.hypot(dx, dy) <= shape.r * Math.min(W, H);
  } else if (shape.type === 'line') {
    // distance from point to line segment, with ~12px tolerance
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
let   inspecting   = false; // whether inspector is open

function openInspector(shape, anchorX, anchorY) {
  inspecting = true;
  inspColor.value = shape.color;
  inspColorPrev.style.background = shape.color;

  // Size: use a scale factor stored on shape (default 1.0)
  if (shape.scale == null) shape.scale = 1.0;
  const pct = Math.round(shape.scale * 100);
  inspSize.value = pct;
  inspSizeVal.textContent = pct + '%';

  // Position near click but keep on screen
  const area = canvasArea.getBoundingClientRect();
  const iW = 236, iH = 180;
  let left = anchorX + 12;
  let top  = anchorY - 20;
  if (left + iW > area.width)  left = anchorX - iW - 12;
  if (top  + iH > area.height) top  = area.height - iH - 8;
  if (top < 4) top = 4;
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

// Scale a shape around its centre
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

// Close inspector when clicking outside it
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
  if (appMode !== 'draw') return;

  const pos = canvasPos(e);

  // Check if clicking on the active layer's shape
  const layer = layers[activeLayer];
  if (layer.shape && hitTestShape(layer.shape, pos.x, pos.y)) {
    const r = canvas.getBoundingClientRect();
    openInspector(layer.shape, e.clientX - r.left, e.clientY - r.top);
    return;
  }

  // Otherwise start drawing
  if (inspecting) { closeInspector(); return; }
  isDrawing = true;
  drawStart = pos;
});

canvas.addEventListener('mousemove', e => {
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

    // Shift: constrain to horizontal or vertical axis from recording start
    if (e.shiftKey && recordedPath.length > 0) {
      const origin = recordedPath[0];
      const dx = Math.abs(x - origin.x);
      const dy = Math.abs(y - origin.y);
      if (dx >= dy) y = origin.y; // lock to horizontal
      else          x = origin.x; // lock to vertical
    }

    const t = performance.now();
    if (!recordStartTime) recordStartTime = t;
    const elapsed = (t - recordStartTime) / 1000;
    recordedPath.push({ t: elapsed, x, y });

    drawFrame(0);
    // live position of shape
    const layer = layers[activeLayer];
    if (layer.shape) {
      const centre = shapeCentre(layer.shape);
      const dx = (x - centre.x) * canvas.width;
      const dy = (y - centre.y) * canvas.height;
      drawShape(layer.shape, dx, dy);
    }
    // trail
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

  // Check it has some minimum size
  const tooSmall = (shape.type === 'circle' && shape.r * Math.min(canvas.width, canvas.height) < 4) ||
                   (shape.type !== 'circle' && Math.abs(shape.x2 - shape.x1) * canvas.width < 4 &&
                    Math.abs(shape.y2 - shape.y1) * canvas.height < 4);
  if (tooSmall) { drawFrame(playheadPct); return; }

  layers[activeLayer].shape = shape;
  layers[activeLayer].animation = null;
  updateLayerTabs();
  drawFrame(playheadPct);
  checkExportReady();

  // Auto-switch to record mode
  setAppMode('record');
  setStatus(`Shape drawn on Layer ${activeLayer+1}. Press REC to record its motion.`);
});

canvas.addEventListener('mouseleave', e => {
  if (isDrawing) {
    // commit whatever is drawn so far
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
  // Update play icon to pause
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
  // update time display
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
// init
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

document.getElementById('export-btn').addEventListener('click', exportMP4);

function setModalStatus(msg) {
  document.getElementById('modal-status').textContent = msg;
}

async function exportMP4() {
  const modal   = document.getElementById('modal');
  const progress = document.getElementById('modal-progress');
  modal.classList.add('visible');
  progress.style.width = '0%';
  setModalStatus('Preparing…');

  let cancelled = false;
  document.getElementById('modal-cancel').onclick = () => {
    cancelled = true;
    modal.classList.remove('visible');
  };


// ── Try WebCodecs path (Chrome 94+, Edge 94+) ─────────────────────────────
  if (typeof VideoEncoder !== 'undefined') {
    try {
      await exportViaWebCodecs(modal, progress, () => cancelled, setModalStatus);
      return;
    } catch(e) {
      console.warn('WebCodecs failed, trying MediaRecorder fallback:', e);
    }
  }

  // ── MediaRecorder fallback (Firefox, Safari) ───────────────────────────────
  try {
    await exportViaMediaRecorder(modal, progress, () => cancelled, setModalStatus);
  } catch(err) {
    console.error(err);
    modal.classList.remove('visible');
    setStatus('Export failed: ' + err.message);
  }
}

// ── WebCodecs path → real H.264 MP4 ──────────────────────────────────────────
async function exportViaWebCodecs(modal, progress, isCancelled, setStatus2) {
  const W = canvas.width, H = canvas.height;
  // Width/height must be even for H.264
  const EW = W % 2 === 0 ? W : W - 1;
  const EH = H % 2 === 0 ? H : H - 1;

  setStatus2('Encoding H.264…');

  const chunks = [];
  let encoderConfig = null;

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig) encoderConfig = meta.decoderConfig;
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      chunks.push({ data: buf, type: chunk.type, ts: chunk.timestamp, duration: chunk.duration });
    },
    error: e => { throw e; }
  });

  encoder.configure({
    codec: 'avc1.42001f',         // H.264 Baseline Profile Level 3.1
    width: EW, height: EH,
    bitrate: 4_000_000,
    framerate: FPS,
    latencyMode: 'quality',
  });

  const totalFrames = Math.ceil(recordDuration * FPS);
  const offscreen = document.createElement('canvas');
  offscreen.width = EW; offscreen.height = EH;
  const offCtx = offscreen.getContext('2d');

  for (let frame = 0; frame <= totalFrames; frame++) {
    if (isCancelled()) { encoder.close(); return; }

    const pct = frame / totalFrames;
    const t   = pct * recordDuration;

    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, EW, EH);
    renderLayersToCtx(offCtx, EW, EH, t);

    const vf = new VideoFrame(offscreen, {
      timestamp: (frame / FPS) * 1_000_000,
      duration:  (1 / FPS)    * 1_000_000,
    });
    encoder.encode(vf, { keyFrame: frame % (FPS * 2) === 0 });
    vf.close();

    progress.style.width = ((frame / totalFrames) * 75) + '%';
    if (frame % 5 === 0) {
      setStatus2(`Encoding frame ${frame}/${totalFrames}`);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  await encoder.flush();
  encoder.close();

  if (isCancelled()) return;
  setStatus2('Muxing MP4…');
  progress.style.width = '85%';

  // Build a minimal MP4 (ftyp + moov + mdat) around the raw AVC chunks
  const mp4 = muxAvcToMp4(chunks, EW, EH, FPS, encoderConfig);

  progress.style.width = '100%';
  setStatus2('Done!');

  const blob = new Blob([mp4], { type: 'video/mp4' });
  triggerDownload(blob, 'motion-export.mp4');
  setTimeout(() => modal.classList.remove('visible'), 600);
  setStatus('✓ Saved motion-export.mp4');
}

// ── Minimal AVC → MP4 muxer ──────────────────────────────────────────────────
function muxAvcToMp4(chunks, W, H, fps, decoderConfig) {
  const w32 = v => new Uint8Array([(v>>>24)&0xff,(v>>>16)&0xff,(v>>>8)&0xff,v&0xff]);
  const w16 = v => new Uint8Array([(v>>>8)&0xff, v&0xff]);
  const cat = (...parts) => { const t=[]; for(const p of parts) t.push(...p); return new Uint8Array(t); };
  const s2b = s => new Uint8Array([...s].map(c=>c.charCodeAt(0)));

  function box(name, ...payloads) {
    const body = cat(...payloads);
    const size = 8 + body.length;
    return cat(w32(size), s2b(name), body);
  }
  function fullbox(name, ver, flags, ...payloads) {
    return box(name, new Uint8Array([ver,(flags>>16)&0xff,(flags>>8)&0xff,flags&0xff]), ...payloads);
  }

  // Build mdat
  const mdatBody = cat(...chunks.map(c => c.data));
  const mdat = cat(w32(8 + mdatBody.length), s2b('mdat'), mdatBody);

  // Sample table data
  const sampleSizes    = new Uint8Array(4 * chunks.length);
  const syncSamples    = [];
  let offset32 = new DataView(sampleSizes.buffer);
  for (let i=0;i<chunks.length;i++) {
    offset32.setUint32(i*4, chunks[i].data.length);
    if (chunks[i].type === 'key') syncSamples.push(i+1);
  }

  const timescale = 90000;
  const frameDur  = Math.round(timescale / fps);
  const totalDur  = frameDur * chunks.length;

  // stts: all frames same duration
  const stts = fullbox('stts',0,0,
    w32(1), w32(chunks.length), w32(frameDur)
  );
  // stss: sync (key) samples
  const stssEntries = new Uint8Array(4*syncSamples.length);
  const ssv = new DataView(stssEntries.buffer);
  syncSamples.forEach((n,i)=>ssv.setUint32(i*4,n));
  const stss = fullbox('stss',0,0, w32(syncSamples.length), stssEntries);
  // stsc: 1 chunk with all samples
  const stsc = fullbox('stsc',0,0, w32(1), w32(1), w32(chunks.length), w32(1));
  // stsz
  const stsz = fullbox('stsz',0,0, w32(0), w32(chunks.length), sampleSizes);
  // stco placeholder — patched below
  const stcoPayload = cat(w32(1), w32(0xDEADBEEF));
  const stco = fullbox('stco',0,0, stcoPayload);

  // avcC — try to extract from decoderConfig, else use a generic one
  let avcC;
  if (decoderConfig && decoderConfig.description) {
    const desc = decoderConfig.description;
    const raw  = desc instanceof ArrayBuffer ? new Uint8Array(desc)
               : desc.buffer ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
               : null;
    if (raw) {
      avcC = cat(w32(8+raw.length), s2b('avcC'), raw);
    }
  }
  if (!avcC) {
    // Baseline 3.1 generic avcC
    const avcCData = new Uint8Array([
      0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x00, 0x01, 0x00, 0x00
    ]);
    avcC = cat(w32(8+avcCData.length), s2b('avcC'), avcCData);
  }

  // avc1 sample entry (86 bytes fixed + avcC)
  const avc1 = box('avc1',
    new Uint8Array(6),              // reserved
    w16(1),                         // data ref index
    new Uint8Array(16),             // pre-defined + reserved
    w16(W), w16(H),
    new Uint8Array([0,0x48,0,0, 0,0x48,0,0]), // 72dpi x2
    new Uint8Array(4),              // reserved
    w16(1),                         // frame count
    new Uint8Array(32),             // compressor name
    w16(0x18),                      // depth
    new Uint8Array([0xff,0xff]),     // pre-defined
    avcC
  );

  const stsd  = fullbox('stsd',0,0, w32(1), avc1);
  const stbl  = box('stbl', stsd, stts, stss, stsc, stsz, stco);
  const url   = fullbox('url ',0,1);
  const dref  = fullbox('dref',0,0, w32(1), url);
  const dinf  = box('dinf', dref);
  const vmhd  = fullbox('vmhd',0,1, w16(0), new Uint8Array(6));
  const minf  = box('minf', vmhd, dinf, stbl);
  const hdlr  = fullbox('hdlr',0,0, w32(0), s2b('vide'), w32(0),w32(0),w32(0), s2b('Video\0'));
  const mdhd  = fullbox('mdhd',0,0, w32(0),w32(0), w32(timescale), w32(totalDur), w16(0x55c4),w16(0));
  const mdia  = box('mdia', mdhd, hdlr, minf);
  const tkhd  = fullbox('tkhd',0,3,
    w32(0),w32(0), w32(1), w32(0), w32(totalDur),
    new Uint8Array(8), w16(0),w16(0),w16(0x0100),w16(0), w32(0),
    w32(0x00010000),w32(0),w32(0), w32(0),w32(0x00010000),w32(0), w32(0),w32(0),w32(0x40000000),
    w32(W<<16), w32(H<<16)
  );
  const trak  = box('trak', tkhd, mdia);
  const mvhd  = fullbox('mvhd',0,0,
    w32(0),w32(0), w32(timescale), w32(totalDur),
    w32(0x00010000),w16(0x0100),new Uint8Array(10),
    w32(0x00010000),w32(0),w32(0), w32(0),w32(0x00010000),w32(0), w32(0),w32(0),w32(0x40000000),
    new Uint8Array(24), w32(2)
  );
  const moov  = box('moov', mvhd, trak);

  // ftyp
  const ftyp = box('ftyp', s2b('mp42'), w32(0), s2b('mp42'), s2b('isom'), s2b('avc1'));

  // Calculate mdat offset and patch stco
  const mdatOffset = ftyp.length + moov.length;
  const moovMut    = new Uint8Array(moov);
  // Find 0xDEADBEEF in moov and replace with real offset
  const deadBeef = [0xDE,0xAD,0xBE,0xEF];
  for (let i=0;i<moovMut.length-4;i++) {
    if (moovMut[i]===0xDE&&moovMut[i+1]===0xAD&&moovMut[i+2]===0xBE&&moovMut[i+3]===0xEF) {
      const real = mdatOffset + 8;
      moovMut[i]  =(real>>>24)&0xff; moovMut[i+1]=(real>>>16)&0xff;
      moovMut[i+2]=(real>>>8)&0xff;  moovMut[i+3]=real&0xff;
      break;
    }
  }

  const out = new Uint8Array(ftyp.length + moovMut.length + mdat.length);
  out.set(ftyp, 0);
  out.set(moovMut, ftyp.length);
  out.set(mdat, ftyp.length + moovMut.length);
  return out;
}

// ── MediaRecorder fallback → WebM download (renamed .mp4 for convenience) ────
async function exportViaMediaRecorder(modal, progress, isCancelled, setStatus2) {
  const W = canvas.width, H = canvas.height;
  const offscreen = document.createElement('canvas');
  offscreen.width = W; offscreen.height = H;
  const offCtx = offscreen.getContext('2d');

  setStatus2('Recording frames…');

  const stream = offscreen.captureStream(FPS);
  const chunks = [];
  let mimeType = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  recorder.start(100);

  const totalFrames = Math.ceil(recordDuration * FPS);
  for (let frame = 0; frame <= totalFrames; frame++) {
    if (isCancelled()) { recorder.stop(); return; }

    const pct = frame / totalFrames;
    const t   = pct * recordDuration;

    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, W, H);
    renderLayersToCtx(offCtx, W, H, t);

    progress.style.width = ((frame / totalFrames) * 90) + '%';
    if (frame % 5 === 0) setStatus2(`Frame ${frame}/${totalFrames}`);
    await new Promise(r => setTimeout(r, 1000 / FPS));
  }

  await new Promise(resolve => {
    recorder.onstop = resolve;
    recorder.stop();
  });

  if (isCancelled()) return;
  progress.style.width = '100%';
  setStatus2('Done!');

  const blob = new Blob(chunks, { type: mimeType });
  triggerDownload(blob, 'motion-export.webm');
  setTimeout(() => modal.classList.remove('visible'), 600);
  setStatus('✓ Saved motion-export.webm (open in VLC or convert with HandBrake)');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── SHARED RENDER HELPER ────────────────────────────────────────────────────
function renderLayersToCtx(offCtx, W, H, t) {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer.shape) continue;
    let dx = 0, dy = 0;
    if (layer.animation && layer.animation.length > 0) {
      const centre = shapeCentre(layer.shape);
      const pos = getPositionAtTime(layer.animation, t);
      if (!pos) continue;
      dx = (pos.x - centre.x) * W;
      dy = (pos.y - centre.y) * H;
    }
    drawShapeCtx(offCtx, layer.shape, W, H, dx, dy);
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
updateLayerTabs();
drawFrame(0);
setAppMode('draw');

