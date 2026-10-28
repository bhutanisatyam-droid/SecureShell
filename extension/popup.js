const DEFAULTS = {
  backendUrl: 'http://localhost:8000',
  token: 'dev-token',
  micEnabled: false,
  autoDisconnect: false,
  closeTabFallback: false,
  keepChatOpen: true,
};
const FIELDS = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);

async function loadSettings() {
  const stored = await chrome.storage.local.get(FIELDS);
  const s = { ...DEFAULTS, ...stored };
  for (const k of FIELDS) {
    const el = $(k);
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = s[k];
    el.addEventListener('change', saveSettings);
  }
  return s;
}

function readSettings() {
  const s = {};
  for (const k of FIELDS) {
    const el = $(k);
    s[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  return s;
}

async function saveSettings() {
  await chrome.storage.local.set(readSettings());
}

function showStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: 'get_status' });
  if (!st || !st.active) {
    showStatus('Not monitoring.');
    return;
  }
  const c = st.capture || {};
  const lines = [
    `Monitoring session ${st.sessionId}`,
    `Backend: ${c.ws || '…'}${c.last_ws_error && c.ws !== 'open' ? ` (${c.last_ws_error})` : ''}`,
    `Tab audio: ${c.tab_audio || '…'} · Video: ${c.video || '…'} · Mic: ${c.local_mic || '…'}`,
  ];
  if (c.fatal) lines.push(`ERROR: ${c.fatal}`);
  showStatus(lines.join('\n'), c.fatal || c.ws !== 'open' ? 'err' : 'on');
}

$('start').addEventListener('click', async () => {
  const settings = readSettings();
  await chrome.storage.local.set(settings);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith('https://meet.google.com/')) {
    showStatus('Open the Google Meet call tab first, then start from there.', 'err');
    return;
  }
  try {
    // Must run from the user gesture; the stream id is consumed by the offscreen document.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const r = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, streamId, settings });
    showStatus(r && r.ok ? `Starting session ${r.sessionId}…` : `Failed: ${r && r.error}`, r && r.ok ? 'on' : 'err');
  } catch (e) {
    showStatus(`Could not capture tab: ${e.message || e}`, 'err');
  }
});

$('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  refresh();
});

$('grantMic').addEventListener('click', () => chrome.tabs.create({ url: 'permission.html' }));

loadSettings().then(refresh);
setInterval(refresh, 1000);
