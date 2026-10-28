// Service worker: coordinates the monitored tab, the offscreen capture document and the
// content script. Holds no media and no socket; state lives in chrome.storage.session
// because the worker can be terminated at any time.

const OFFSCREEN_URL = 'offscreen.html';

async function getState() {
  const { cs } = await chrome.storage.session.get('cs');
  return cs || { active: false };
}

async function setState(patch) {
  const cs = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ cs });
  return cs;
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture the consented Google Meet tab audio/video for fraud analysis.',
  });
}

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) await chrome.offscreen.closeDocument();
}

function toTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});
}

async function start({ tabId, streamId, settings }) {
  const cur = await getState();
  if (cur.active) await stop('restart');
  const sessionId = `cs-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${crypto.randomUUID().slice(0, 6)}`;
  await ensureOffscreen();
  await setState({ active: true, tabId, sessionId, settings, startedAt: Date.now(), capture: {} });
  await toOffscreen({ type: 'start', tabId, streamId, sessionId, settings,
    extensionVersion: chrome.runtime.getManifest().version });
  await toTab(tabId, { type: 'monitoring', active: true, sessionId, settings });
  return { ok: true, sessionId };
}

async function stop(reason = 'user') {
  const st = await getState();
  if (st.active) {
    await toOffscreen({ type: 'stop', reason });
    if (st.tabId != null) await toTab(st.tabId, { type: 'monitoring', active: false });
  }
  await setState({ active: false });
  // Give the offscreen document a moment to flush session_stop before closing it.
  setTimeout(() => closeOffscreen().catch(() => {}), 500);
  return { ok: true };
}

// Only ever closes the originally monitored tab, and only when the user enabled the fallback.
async function closeTabFallback(outcome) {
  const st = await getState();
  if (!st.active || !st.settings?.closeTabFallback || st.tabId == null) return false;
  const tabId = st.tabId;
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    await toOffscreen({ type: 'action_outcome', outcome: {
      action_id: outcome.action_id, action_type: 'close_tab_fallback', status: 'failed',
      details: { error: String(e) } } });
    return false;
  }
  await toOffscreen({ type: 'action_outcome', outcome: {
    action_id: outcome.action_id, action_type: 'close_tab_fallback', status: 'target_tab_closed',
    details: { tab_id: tabId, note: 'Closed the monitored Meet tab only; other participants may remain in the meeting.' } } });
  setTimeout(() => stop('tab_closed'), 300);
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return false; // addressed to the offscreen document
  (async () => {
    const st = await getState();
    const fromMonitoredTab = sender.tab && sender.tab.id === st.tabId;
    switch (msg.type) {
      case 'start':
        return start(msg);
      case 'stop':
        return stop('user');
      case 'get_status':
        return st;
      case 'capture_status': // from offscreen
        await setState({ capture: msg.status });
        return true;
      case 'backend_message': // from offscreen -> content script
        if (st.active && st.tabId != null) await toTab(st.tabId, { type: 'backend_message', msg: msg.msg });
        return true;
      case 'chat_message':
        if (st.active && fromMonitoredTab) await toOffscreen({ type: 'chat_message', chat: msg.chat });
        return true;
      case 'warning_shown':
        if (st.active && fromMonitoredTab) await toOffscreen({ type: 'warning_shown', details: msg.details });
        return true;
      case 'action_outcome':
        if (!st.active || !fromMonitoredTab) return false;
        await toOffscreen({ type: 'action_outcome', outcome: msg.outcome });
        if (['failed', 'unverified'].includes(msg.outcome.status)) await closeTabFallback(msg.outcome);
        return true;
      case 'content_ready':
        if (st.active && fromMonitoredTab) {
          return { active: true, sessionId: st.sessionId, settings: st.settings };
        }
        return { active: false };
      default:
        return false;
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await getState();
  if (st.active && st.tabId === tabId) await stop('tab_closed');
});
