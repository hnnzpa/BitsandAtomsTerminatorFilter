// ============================================================
// ADMIRA AR — SCRIPT ÚNICO UNIFICADO ESTABLE
// ============================================================

(function initMatrix() {
  const CHARS = '01<>{}[]|\\/@#$%アイウXYZ0123456789ABCDEF';
  document.addEventListener('DOMContentLoaded', () => {
    const wrap = document.getElementById('instMatrix');
    if (!wrap) return;
    for (let i = 0; i < 8; i++) {
      const s = document.createElement('div');
      s.className = 'inst-stream';
      s.style.left = (Math.random() * 100) + '%';
      s.style.animationDuration = (5 + Math.random() * 7) + 's';
      s.style.animationDelay = (-Math.random() * 10) + 's';
      s.style.opacity = (0.04 + Math.random() * 0.08);
      let t = '';
      for (let j = 0; j < 10; j++) t += CHARS[Math.floor(Math.random() * CHARS.length)] + '\n';
      s.textContent = t;
      wrap.appendChild(s);
    }
    setInterval(() => {
      wrap.querySelectorAll('.inst-stream').forEach(s => {
        if (Math.random() < 0.2) {
          const lines = s.textContent.split('\n');
          lines[Math.floor(Math.random() * lines.length)] = CHARS[Math.floor(Math.random() * CHARS.length)];
          s.textContent = lines.join('\n');
        }
      });
    }, 150);
  });
})();

const Detector = (() => {
  let model = null;
  const SCORE_THRESHOLD = 0.75, MIN_FACE_SIZE = 0.03;

  function withTimeout(promise, ms) {
    return Promise.race([ promise, new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), ms)) ]);
  }

  async function load(onProgress) {
    try {
      onProgress('Cargando TensorFlow.js runtime...', 20);
      await withTimeout(tf.ready(), 12000);
      onProgress('Inicializando backend WebGL...', 40);
      try {
        await withTimeout(tf.setBackend('webgl'), 8000);
        await withTimeout(tf.ready(), 8000);
      } catch (e) {
        onProgress('WebGL falló, usando CPU...', 45);
        await withTimeout(tf.setBackend('cpu'), 8000);
        await withTimeout(tf.ready(), 8000);
      }
      onProgress('Descargando modelo BlazeFace...', 60);

      // PATCH: blazeface.load() llama tf.loadGraphModel con fromTFHub:true
      // tfhub.dev hace HTTP 301 que NW.js no sigue → falla el parse JSON
      // Interceptamos tf.loadGraphModel y redirigimos a jsDelivr (JSON puro)
      if (tf.loadGraphModel && !tf._patched) {
        var _orig = tf.loadGraphModel.bind(tf);
        tf.loadGraphModel = function(url, opts) {
          if (typeof url === 'string' && url.indexOf('tfhub.dev') !== -1 && url.indexOf('blazeface') !== -1) {

            return _orig('https://cdn.jsdelivr.net/gh/wangmengHB/local-tfjs-models@master/blazeface/google/model.json', {});
          }
          return _orig(url, opts);
        };
        tf._patched = true;
      }

      model = await withTimeout(blazeface.load({ maxFaces: 5, scoreThreshold: SCORE_THRESHOLD }), 25000);
      onProgress('Modelo BlazeFace listo ✓', 100);

      return true;
    } catch (err) {
      console.error('[DET] Load FAILED:', err);
      return false;
    }
  }

  var _detectCanvas = null;
  var _detectCallCount = 0;

  async function detect(videoEl) {
    if (!model || !videoEl || videoEl.readyState < 2) {
      _detectCallCount++;
      return [];
    }
    try {
      // Canvas intermedio limpio — sin CSS filter, sin espejo
      if (!_detectCanvas) {
        _detectCanvas = document.createElement('canvas');
      }
      // Solo redimensionar si cambia el tamaño del video
      var tvw = videoEl.videoWidth  || 640;
      var tvh = videoEl.videoHeight || 480;
      if (_detectCanvas.width !== tvw || _detectCanvas.height !== tvh) {
        _detectCanvas.width  = tvw;
        _detectCanvas.height = tvh;
      }
      var dctx = _detectCanvas.getContext('2d');
      dctx.drawImage(videoEl, 0, 0, tvw, tvh);


            const preds = await model.estimateFaces(_detectCanvas, false);
      _detectCallCount++;


            if (!preds || !preds.length) return [];
      const vw = videoEl.videoWidth || videoEl.clientWidth;
      const vh = videoEl.videoHeight || videoEl.clientHeight;
      const faces = [];
      for (const p of preds) {
        const score = p.probability ? p.probability[0] : 0;
        if (score < SCORE_THRESHOLD) continue;
        const [x1, y1] = p.topLeft, [x2, y2] = p.bottomRight;
        const faceW = (x2 - x1) / vw, faceH = (y2 - y1) / vh;
        if (faceW < MIN_FACE_SIZE || faceH < MIN_FACE_SIZE) continue;
        if (faceW / faceH < 0.3 || faceW / faceH > 2.5) continue;
        faces.push({ box: { xMin: x1/vw, yMin: y1/vh, xMax: x2/vw, yMax: y2/vh, width: faceW, height: faceH }, score });
      }
      return faces;
    } catch (e) {
      console.error('[DET] detect error:', e);
      return [];
    }
  }
  return { load, detect };
})();

const Renderer = (() => {
  let canvas, ctx;
  let W = 1280, H = 720;
  const trackedFaces = new Map(), smoothed = new Map();
  let nextFaceId = 0;
  const EA = 0.10, MAX_MISSED = 15, SCAN_DURATION = 1800;

  function smGet(id, key, raw) {
    if (!smoothed.has(id)) smoothed.set(id, {});
    const s = smoothed.get(id);
    if (s[key] === undefined) { s[key] = raw; return raw; }
    s[key] += (raw - s[key]) * EA;
    return s[key];
  }

  function iou(a, b) {
    const ix1 = Math.max(a.xMin, b.xMin), iy1 = Math.max(a.yMin, b.yMin);
    const ix2 = Math.min(a.xMax, b.xMax), iy2 = Math.min(a.yMax, b.yMax);
    const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    if (inter === 0) return 0;
    return inter / ((a.xMax - a.xMin) * (a.yMax - a.yMin) + (b.xMax - b.xMin) * (b.yMax - b.yMin) - inter);
  }

  function render(detections, videoEl) {
    if (!canvas || !ctx || !videoEl) return;
    const vw = videoEl.videoWidth || 1280;
    const vh = videoEl.videoHeight || 720;
    if (vw > 0 && vh > 0 && (canvas.width !== vw || canvas.height !== vh)) {
      canvas.width = vw; canvas.height = vh; W = vw; H = vh; smoothed.clear();
    }
    ctx.clearRect(0, 0, W, H);
    const now = performance.now();

    for (const [, track] of trackedFaces) track.missedFrames++;

    if (detections && detections.length) {
      const usedIds = new Set();
      for (const det of detections) {
        let bestId = null, bestScore = 0.05; // IoU bajo = asociar aunque haya movimiento
        for (const [id, track] of trackedFaces) {
          if (usedIds.has(id)) continue;
          const score = iou(det.box, track.box);
          if (score > bestScore) { bestScore = score; bestId = id; }
        }
        if (bestId !== null) {
          trackedFaces.get(bestId).box = det.box;
          trackedFaces.get(bestId).missedFrames = 0;
          usedIds.add(bestId);
        } else {
          trackedFaces.set(nextFaceId++, {
            box: det.box,
            pct: Math.floor(Math.random() * 41) + 60,
            phase: 'scanning', phaseStart: now, missedFrames: 0
          });
        }
      }
    }

    const toDelete = [];
    for (const [id, track] of trackedFaces) {
      if (track.missedFrames > MAX_MISSED) toDelete.push(id);
    }
    for (let di = 0; di < toDelete.length; di++) {
      trackedFaces.delete(toDelete[di]); smoothed.delete(toDelete[di]);
    }

    for (const [id, track] of trackedFaces) {
      if (track.phase === 'scanning' && now - track.phaseStart >= SCAN_DURATION) track.phase = 'locked';
      try { drawFace(id, track, now); } catch(e) { console.warn('[REN] drawFace error:', e); }
    }
  }

  function drawFace(id, track, now) {
    const box = track.box;
    // El video CSS está espejado (scaleX(-1)) pero blazeface detecta sin espejo
    // → invertir X para que el recuadro coincida con la cara en pantalla
    const x1 = smGet(id, 'x1', box.xMin * W), y1 = smGet(id, 'y1', box.yMin * H);
    const x2 = smGet(id, 'x2', box.xMax * W), y2 = smGet(id, 'y2', box.yMax * H);const bw = x2 - x1, bh = y2 - y1;
    if (bw < 10) return;
    const rx1 = x1 - bw * 0.15, ry1 = y1 - bw * 0.12, rw = bw * 1.3, rh = bh * 1.3;
    const alpha = track.missedFrames > 2 ? Math.max(0, 1 - (track.missedFrames - 2) / 4) : 1;
    if (alpha <= 0) return;

    ctx.save(); ctx.globalAlpha = alpha;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.setLineDash([6, 5]);
    ctx.strokeRect(rx1, ry1, rw, rh); ctx.setLineDash([]);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    const cLen = Math.min(rw, rh) * 0.22;
    [[rx1,ry1,1,1],[rx1+rw,ry1,-1,1],[rx1,ry1+rh,1,-1],[rx1+rw,ry1+rh,-1,-1]].forEach(([cx,cy,dx,dy]) => {
      ctx.beginPath(); ctx.moveTo(cx+dx*cLen, cy); ctx.lineTo(cx,cy); ctx.lineTo(cx, cy+dy*cLen); ctx.stroke();
    });

    if (track.phase === 'scanning') {
      const scanY = ry1 + ((now * 0.001 * 1.4 * rh) % rh);
      const grad = ctx.createLinearGradient(0, scanY - 12, 0, scanY + 12);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad; ctx.fillRect(rx1, scanY - 12, rw, 24);
      ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(rx1, ry1+rh+8, rw, 36);
      ctx.fillStyle = '#fff'; ctx.font = '11px monospace';
      ctx.fillText('SCANNING...', rx1+9, ry1+rh+22);
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(rx1, ry1+rh+8, rw, 36);
      const colorPct = track.pct >= 90 ? '#ff3333' : track.pct >= 75 ? '#ff9900' : '#ffffff';
      ctx.fillStyle = colorPct; ctx.font = 'bold 20px monospace';
      ctx.fillText(track.pct + '%', rx1+9, ry1+rh+34);
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 16px monospace';
      ctx.fillText('You are ' + track.pct + '% robot', rx1, ry1-10);
    }
    ctx.restore();
  }

  return {
    init: function(cvs) { canvas = cvs; ctx = cvs.getContext('2d'); },
    render: render
  };
})();

const App = (() => {
  const IMGBB_API_KEY = 'ee456fe38fdb878ed57696c6092b971e';
  const State = { running: false, videoEl: null, frameCount: 0, lastFPSTime: 0 };
  const Filter = { contrast: 130, brightness: 55, saturate: 970, hueRotate: -40 };
  const Countdown = { active: false, endsAt: 0, SECS: 5, lastTick: -1 };

  function buildFilter() {
    return 'grayscale(100%) brightness(' + Filter.brightness + '%) contrast(' + Filter.contrast +
           '%) sepia(100%) hue-rotate(' + Filter.hueRotate + 'deg) saturate(' + Filter.saturate + '%)';
  }

  const QRState = { phase: 'hidden', url: null, tickerId: null, safetyLockEndsAt: 0, photoCooldownEndsAt: 0, currentPhotoId: null };
  let globalPhotoID = 0;
  const MINI_COLORS = ['#ff2200', '#ff0055', '#ff7700'];
  const els = { gestureHudDot: null, gestureHudLabel: null };

  function executePhotoAction() {
    const now = performance.now();
    if (QRState.phase === 'big') {
      if (now < QRState.safetyLockEndsAt) return;
      manualCloseBigQR();
    } else if (!Countdown.active) {
      if (now < QRState.photoCooldownEndsAt) return;
      startCountdown();
    }
  }

  function updateGestureHudStatus() {
    const now = performance.now();
    if (!els.gestureHudDot || !els.gestureHudLabel) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      els.gestureHudDot.className = 'status-dot disconnected';
      els.gestureHudLabel.textContent = 'GESTURE: OFFLINE';
      return;
    }
    let isBlocked = !State.running || QRState.phase === 'big' || (now < QRState.photoCooldownEndsAt);
    if (isBlocked) {
      els.gestureHudDot.className = 'status-dot blocked';
      els.gestureHudLabel.textContent = 'GESTURE: BLOCKED';
    } else {
      els.gestureHudDot.className = 'status-dot active';
      els.gestureHudLabel.textContent = 'GESTURE: READY';
    }
  }

  let ws;
  function connectWebSocket() {
    ws = new WebSocket('ws://localhost:8765');
    ws.onopen = function() { console.log('✅ ADMIRA: WebSocket conectado'); };
    ws.onmessage = function(event) { if (event.data === 'TRIGGER_PHOTO') executePhotoAction(); };
    ws.onclose = function() { setTimeout(connectWebSocket, 3000); };
  }

  window.addEventListener('keydown', function(e) {
    if (e.key.toLowerCase() === 'f' || e.code === 'KeyF') executePhotoAction();
  });
  try { if (window.top) window.top.addEventListener('keydown', function(e) {
    if (e.key.toLowerCase() === 'f' || e.code === 'KeyF') executePhotoAction();
  }); } catch(e) {}

  function startCountdown() {
    Countdown.active = true;
    Countdown.endsAt = performance.now() + Countdown.SECS * 1000;
    Countdown.lastTick = Countdown.SECS;
    document.getElementById('countdownOverlay').style.display = 'flex';
    document.getElementById('gestureDot').className = 'g-dot g-dot--active';
    document.getElementById('gestureStateLabel').textContent = '¡FOTO EN BREVE!';
    updateCountdown(Countdown.SECS);
  }

  function updateCountdown(n) {
    const el = document.getElementById('countdownNumber');
    el.textContent = n; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }

  async function triggerSnapshot() {
    const v = State.videoEl, gc = document.getElementById('glCanvas');
    const fl = document.createElement('div'); fl.className = 'snapshot-flash'; document.body.appendChild(fl);
    setTimeout(function() { try { fl.remove(); } catch(e) {} }, 600);
    const sn = document.createElement('canvas'); sn.width = v.videoWidth; sn.height = v.videoHeight;
    const ctx = sn.getContext('2d');
    ctx.filter = buildFilter();
    ctx.drawImage(v, 0, 0, sn.width, sn.height);    ctx.filter = 'none';
    if (gc && gc.width > 0 && gc.height > 0) ctx.drawImage(gc, 0, 0, sn.width, sn.height);
    sn.toBlob(function(blob) {
      if (!IMGBB_API_KEY) return;
      const rd = new FileReader();
      rd.onload = function() {
        const base64 = rd.result.split(',')[1];
        const form = new FormData();
        form.append('key', IMGBB_API_KEY); form.append('image', base64);
        fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.data && data.data.url_viewer) showQROverlay(data.data.url_viewer);
            else document.getElementById('gestureStateLabel').textContent = 'ERROR API IMGBB';
          })
          .catch(function(err) { console.error('ImgBB error:', err); });
      };
      rd.readAsDataURL(blob);
    }, 'image/png');
  }

  function showQROverlay(url) {
    QRState.phase = 'big'; QRState.url = url; document.body.classList.add('overlay-active');
    const currentIdNum = globalPhotoID; globalPhotoID++; if (globalPhotoID > 99) globalPhotoID = 0;
    QRState.currentPhotoId = currentIdNum;
    const displayId = currentIdNum.toString().padStart(2, '0');
    document.getElementById('qrBigId').textContent = '◈ PHOTO: ' + displayId;
    QRState.safetyLockEndsAt = performance.now() + 20000;
    document.getElementById('qrOverlay').style.display = 'flex';
    document.getElementById('qrUrl').textContent = url;
    document.getElementById('qrCode').innerHTML = '';
    new QRCode(document.getElementById('qrCode'), { text: url, width: 200, height: 200, colorDark: '#ff2200', colorLight: '#000000' });
    let timeLeft = 30; document.getElementById('qrTimer').textContent = timeLeft + 's';
    if (QRState.tickerId) clearInterval(QRState.tickerId);
    QRState.tickerId = setInterval(function() {
      timeLeft--;
      document.getElementById('qrTimer').textContent = timeLeft + 's';
      if (timeLeft <= 0) autoCloseBigQR();
    }, 1000);
  }

  function autoCloseBigQR() {
    if (QRState.tickerId) clearInterval(QRState.tickerId);
    document.getElementById('qrOverlay').style.display = 'none';
    document.body.classList.remove('overlay-active');
    QRState.phase = 'hidden'; QRState.photoCooldownEndsAt = performance.now() + 3000;
    createMiniQR(QRState.url, QRState.currentPhotoId);
  }

  function manualCloseBigQR() {
    if (QRState.tickerId) clearInterval(QRState.tickerId);
    document.getElementById('qrOverlay').style.display = 'none';
    document.body.classList.remove('overlay-active');
    QRState.phase = 'hidden'; QRState.photoCooldownEndsAt = performance.now() + 3000;
    if (QRState.url) createMiniQR(QRState.url, QRState.currentPhotoId);
  }

  function createMiniQR(url, photoIdNum) {
    const container = document.getElementById('miniQrContainer'); if (!container) return;
    const color = MINI_COLORS[photoIdNum % MINI_COLORS.length];
    const displayId = photoIdNum.toString().padStart(2, '0');
    const el = document.createElement('div'); el.className = 'qr-mini-item';
    el.style.borderColor = color; el.style.boxShadow = '0 0 15px ' + color + '60';
    el.innerHTML = '<div class="qr-mini-label" style="color:' + color + '">◈ PHOTO: ' + displayId + '</div>' +
                   '<div class="qr-mini-code"></div>' +
                   '<div class="qr-mini-timer" style="color:' + color + '">120s</div>';
    new QRCode(el.querySelector('.qr-mini-code'), { text: url, width: 84, height: 84, colorDark: color, colorLight: '#000000' });
    container.prepend(el);
    let timeLeft = 120; const timerEl = el.querySelector('.qr-mini-timer');
    const ticker = setInterval(function() {
      timeLeft--; timerEl.textContent = timeLeft + 's';
      if (timeLeft <= 0) {
        clearInterval(ticker); el.style.opacity = '0'; el.style.transform = 'translateX(-50px)';
        setTimeout(function() { el.remove(); }, 400);
      }
    }, 1000);
    document.getElementById('gestureDot').className = 'g-dot';
    document.getElementById('gestureStateLabel').textContent = 'ESPERANDO GESTO';
    QRState.currentPhotoId = null;
  }

  async function mainLoop(ts) {
    if (!State.running) return;
    const now = performance.now();

    if (Countdown.active) {
      const left = Math.ceil((Countdown.endsAt - now) / 1000);
      if (left !== Countdown.lastTick) { Countdown.lastTick = left; updateCountdown(left); }
      if (now >= Countdown.endsAt) {
        Countdown.active = false;
        document.getElementById('countdownOverlay').style.display = 'none';
        triggerSnapshot();
      }
    }

    const faces = await Detector.detect(State.videoEl);
    Renderer.render(faces, State.videoEl);

    State.frameCount++;
    if (ts - State.lastFPSTime >= 1000) {
      document.getElementById('statFps').textContent = State.frameCount;
      document.getElementById('fpsLabel').textContent = 'FPS: ' + State.frameCount;
      State.frameCount = 0; State.lastFPSTime = ts;
    }
    document.getElementById('facesVal').textContent = faces.length;

    updateGestureHudStatus();
    requestAnimationFrame(mainLoop);
  }

  async function init() {
    try {
      document.getElementById('loadingStatus').textContent = 'Conectando con OBS...';
      els.gestureHudDot = document.getElementById('gestureHudDot');
      els.gestureHudLabel = document.getElementById('gestureHudLabel');

      try {
        let tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
        tempStream.getTracks().forEach(function(track) { track.stop(); });
      } catch(e) {}

      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoCameras = devices.filter(function(d) { return d.kind === 'videoinput'; });
      const obsCamera = videoCameras.find(function(d) { return d.label.toLowerCase().includes('obs'); });

      let videoConfig = { width: 1280, height: 720 };
      if (obsCamera) videoConfig.deviceId = { exact: obsCamera.deviceId };
      else videoConfig.facingMode = 'user';

      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConfig });
      State.videoEl = document.getElementById('videoEl');
      State.videoEl.srcObject = stream;
      await new Promise(function(r) { State.videoEl.onloadedmetadata = r; });
      State.videoEl.style.filter = buildFilter();

      document.getElementById('camDot').className = 'status-dot active';
      document.getElementById('camLabel').textContent = 'CAM: ONLINE';

      await Detector.load(function(msg, pct) {
        document.getElementById('loadingStatus').textContent = msg;
        document.getElementById('loadingBar').style.width = pct + '%';
      });
      document.getElementById('modelDot').className = 'status-dot active';
      document.getElementById('modelLabel').textContent = 'MODEL: READY';

      document.getElementById('loadingScreen').style.display = 'none';
      document.getElementById('arWrapper').style.display = 'block';
      Renderer.init(document.getElementById('glCanvas'));

      document.getElementById('qrCloseBtn').addEventListener('click', manualCloseBigQR);

      connectWebSocket();

      State.running = true;
      requestAnimationFrame(mainLoop);

    } catch(e) {
      console.error(e);
      document.getElementById('loadingStatus').textContent = 'ERROR DE CÁMARA';
      document.getElementById('camDot').className = 'status-dot error';
      document.getElementById('camLabel').textContent = 'CAM: DENIED';
    }
  }

  return { init: init };
})();

document.addEventListener('DOMContentLoaded', App.init);