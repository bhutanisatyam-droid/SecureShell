// Offscreen document: owns the MediaStreams, AudioContext, frame sampler and the backend
// WebSocket. Survives the popup closing and service-worker restarts.

const TARGET_RATE = 16000;
const CHUNK_MS = 200;
const FRAME_INTERVAL_MS = 2000;
// Sharp enough for the backend's vision model to read a card or document held up in a tile.
const FRAME_MAX_WIDTH = 1920;
const JPEG_QUALITY = 0.8;
const THUMB_W = 32;
const THUMB_H = 18;
const AUDIO_BUFFER_LIMIT = 512 * 1024;
const VIDEO_BUFFER_LIMIT = 128 * 1024;

let s = null; // current session state

const enc = new TextEncoder();

function envelope(eventType, source, payload, eventId) {
  return {
    schema_version: '1.0',
    session_id: s.sessionId,
    event_id: eventId || `${eventType}-${crypto.randomUUID()}`,
    event_type: eventType,
    timestamp_ms: Date.now(),
    source,
    payload,
  };
}

function binaryFrame(header, bytes) {
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, h.length, false);
  out.set(h, 4);
  out.set(new Uint8Array(bytes), 4 + h.length);
  return out.buffer;
}

function wsOpen() {
  return s && s.ws && s.ws.readyState === WebSocket.OPEN;
}

function sendJson(env) {
  if (!wsOpen()) { s.counters.json_dropped++; return false; }
  s.ws.send(JSON.stringify(env));
  return true;
}

function connect() {
  if (!s || s.stopping) return;
  const base = s.settings.backendUrl.replace(/^http/, 'ws').replace(/\/$/, '');
  const url = `${base}/ws/ingest?token=${encodeURIComponent(s.settings.token)}&session_id=${encodeURIComponent(s.sessionId)}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  ws.onopen = () => {
    s.backoff = 1000;
    s.counters.ws_connects++;
    // Offscreen documents only get a subset of chrome.runtime (no getManifest), so the
    // version comes from the service worker. Nothing here may throw: this message carries
    // the user's auto-disconnect opt-in.
    sendJson(envelope('control', 'extension', { command: 'session_start', details: {
      auto_disconnect: !!s.settings.autoDisconnect,
      close_tab_fallback: !!s.settings.closeTabFallback,
      mic_enabled: !!s.settings.micEnabled,
      keep_chat_open: s.settings.keepChatOpen !== false,
      extension_version: s.extensionVersion || 'unknown',
    } }));
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    chrome.runtime.sendMessage({ type: 'backend_message', msg }).catch(() => {});
  };
  ws.onclose = (ev) => {
    if (!s || s.stopping || s.ws !== ws) return;
    s.lastWsError = `closed ${ev.code}`;
    if (ev.code === 4401) { s.fatal = 'Backend rejected token'; reportStatus(); return; }
    setTimeout(connect, s.backoff);
    s.backoff = Math.min(s.backoff * 2, 10000);
  };
  ws.onerror = () => { s.lastWsError = 'websocket error'; };
}

// ---------- audio ----------

async function addPcmTrack(ctx, stream, source, speakerRole) {
  const node = new AudioWorkletNode(ctx, 'pcm-capture', {
    processorOptions: { targetRate: TARGET_RATE, chunkMs: CHUNK_MS },
  });
  const src = ctx.createMediaStreamSource(stream);
  src.connect(node);
  // Keep the worklet pulled by the graph without making it audible.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  const track = { seq: 0, samples: 0, baseMs: null };
  node.port.onmessage = ({ data }) => {
    const n = data.byteLength / 2;
    if (track.baseMs === null) track.baseMs = Date.now() - Math.round((n * 1000) / TARGET_RATE);
    // Timestamps come from the sample count, not the wall clock, so they don't jitter.
    const t0 = track.baseMs + Math.round((track.samples * 1000) / TARGET_RATE);
    track.samples += n;
    const t1 = track.baseMs + Math.round((track.samples * 1000) / TARGET_RATE);
    const seq = track.seq++;
    if (!wsOpen() || s.ws.bufferedAmount > AUDIO_BUFFER_LIMIT) { s.counters[`audio_dropped_${source}`]++; return; }
    const env = envelope('audio_chunk', source, {
      seq, t_start_ms: t0, t_end_ms: t1, sample_rate_hz: TARGET_RATE, channels: 1,
      encoding: 'pcm_s16le', speaker_role: speakerRole,
    }, `${source}-${s.sessionId}-${seq}`);
    s.ws.send(binaryFrame(env, data));
    s.counters[`audio_sent_${source}`]++;
  };
  return { node, src };
}

// ---------- video ----------

function startFrames(videoTrack) {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = new MediaStream([videoTrack]);
  video.play().catch(() => {});
  const canvas = new OffscreenCanvas(1, 1);
  const g = canvas.getContext('2d');
  const thumb = new OffscreenCanvas(THUMB_W, THUMB_H);
  const tg = thumb.getContext('2d', { willReadFrequently: true });
  let prevThumb = null;
  let seq = 0;
  let busy = false;

  // Mean absolute grayscale difference vs the previous frame, 0..1. Lets the backend
  // analyse a frame only once something new (a card, a shared screen) has settled.
  function changeScore() {
    tg.drawImage(video, 0, 0, THUMB_W, THUMB_H);
    const px = tg.getImageData(0, 0, THUMB_W, THUMB_H).data;
    const gray = new Float32Array(THUMB_W * THUMB_H);
    for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
    let score = null;
    if (prevThumb) {
      let sum = 0;
      for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prevThumb[i]);
      score = Math.round((sum / gray.length) * 1000) / 1000;
    }
    prevThumb = gray;
    return score;
  }
  const timer = setInterval(async () => {
    if (busy || !video.videoWidth) return;
    if (!wsOpen() || s.ws.bufferedAmount > VIDEO_BUFFER_LIMIT) { s.counters.video_dropped++; return; }
    busy = true;
    try {
      const scale = Math.min(1, FRAME_MAX_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      const change = changeScore();
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
      const bytes = await blob.arrayBuffer();
      if (!wsOpen()) return;
      const n = seq++;
      const payload = { seq: n, t_ms: Date.now(), width: canvas.width, height: canvas.height, encoding: 'jpeg' };
      if (change !== null) payload.change_score = change;
      const env = envelope('video_frame', 'meet_tab', payload, `frame-${s.sessionId}-${n}`);
      s.ws.send(binaryFrame(env, bytes));
      s.counters.video_sent++;
    } catch (e) {
      s.counters.video_errors++;
    } finally {
      busy = false;
    }
  }, FRAME_INTERVAL_MS);
  return () => { clearInterval(timer); video.srcObject = null; };
}

// ---------- lifecycle ----------

async function start({ streamId, sessionId, settings, extensionVersion }) {
  if (s) await stop('restart');
  s = {
    sessionId, settings, extensionVersion, ws: null, backoff: 1000, stopping: false, fatal: null,
    counters: new Proxy({}, { get: (o, k) => o[k] ?? 0 }), cleanups: [], status: {},
    lastWsError: null,
  };
  connect();

  let tabStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 5 } },
    });
  } catch (e) {
    s.fatal = `Tab capture failed: ${e.message || e}`;
    reportStatus();
    return;
  }
  s.cleanups.push(() => tabStream.getTracks().forEach((t) => t.stop()));

  const ctx = new AudioContext();
  s.cleanups.push(() => ctx.close());
  await ctx.audioWorklet.addModule('pcm-worklet.js');

  // Capturing a tab mutes it for the user; route the tab audio back to the speakers.
  const playback = ctx.createMediaStreamSource(tabStream);
  playback.connect(ctx.destination);
  s.status.tab_audio = 'capturing';
  await addPcmTrack(ctx, tabStream, 'meet_tab', 'remote');

  const [videoTrack] = tabStream.getVideoTracks();
  if (videoTrack) {
    s.cleanups.push(startFrames(videoTrack));
    s.status.video = 'sampling';
  } else {
    s.status.video = 'unavailable';
  }

  if (settings.micEnabled) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      s.cleanups.push(() => mic.getTracks().forEach((t) => t.stop()));
      await addPcmTrack(ctx, mic, 'local_mic', 'local'); // not routed to speakers
      s.status.local_mic = 'capturing';
    } catch (e) {
      // Offscreen documents cannot prompt; permission must be granted on permission.html first.
      s.status.local_mic = `unavailable: ${e.name || e}`;
    }
  } else {
    s.status.local_mic = 'off';
  }

  tabStream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (!s) return;
    s.status.tab_audio = 'ended';
    reportStatus();
  });

  s.statusTimer = setInterval(reportStatus, 2000);
  reportStatus();
}

function captureStatus() {
  return {
    session_id: s.sessionId,
    ws: wsOpen() ? 'open' : 'closed',
    last_ws_error: s.lastWsError,
    fatal: s.fatal,
    ...s.status,
    counters: { ...s.counters },
  };
}

function reportStatus() {
  if (!s) return;
  const status = captureStatus();
  chrome.runtime.sendMessage({ type: 'capture_status', status }).catch(() => {});
  sendJson(envelope('control', 'extension', { command: 'capture_status', details: status }));
}

async function stop(reason) {
  if (!s) return;
  const cur = s;
  sendJson(envelope('control', 'extension', { command: 'session_stop', details: { reason } }));
  cur.stopping = true;
  clearInterval(cur.statusTimer);
  for (const fn of cur.cleanups.reverse()) { try { await fn(); } catch {} }
  try { cur.ws && cur.ws.close(1000); } catch {}
  s = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return false;
  switch (msg.type) {
    case 'start':
      start(msg);
      break;
    case 'stop':
      stop(msg.reason);
      break;
    case 'chat_message':
      if (s) sendJson(envelope('chat_message', 'meet_chat', msg.chat));
      break;
    case 'warning_shown':
      if (s) sendJson(envelope('control', 'extension', { command: 'warning_shown', details: msg.details }));
      break;
    case 'action_outcome':
      if (s) sendJson(envelope('action', 'extension', msg.outcome));
      break;
  }
  return false;
});
