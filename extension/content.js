// Content script on meet.google.com: warning overlay, Meet chat ingestion, and the
// user-authorized Leave Call action. Meet's DOM is not a stable API; every selector here
// is best-effort and must be validated on the real Meet build used for the demo.

(() => {
  if (window.__callshield) return;
  window.__callshield = true;

  const LEVELS = { normal: 0, caution: 1, high: 2, critical: 3 };
  const LEAVE_LABEL = /leave call|end call|hang up|कॉल छोड़ें|कॉल से बाहर|कॉल समाप्त/i;

  let monitoring = false;
  let settings = {};
  let lastShownAssessment = null;
  let pendingAuto = null; // { actionId, timer, deadline }
  let leaving = false;

  // ---------- overlay ----------

  const host = document.createElement('div');
  host.id = 'callshield-overlay-host';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 360px;
              font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; }
      .pill { display: inline-flex; gap: 8px; align-items: center; padding: 6px 12px; border-radius: 999px;
              background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.25); font-weight: 600; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: #9aa0a6; }
      .card { margin-top: 8px; padding: 14px 16px; border-radius: 12px; background: #fff;
              box-shadow: 0 6px 24px rgba(0,0,0,.35); border-left: 6px solid #9aa0a6; }
      .card h2 { margin: 0 0 6px; font-size: 16px; }
      .card ul { margin: 6px 0 10px; padding-left: 18px; max-height: 180px; overflow: auto; }
      .card li { margin: 2px 0; }
      .meta { font-size: 12px; color: #555; }
      .row { display: flex; gap: 8px; margin-top: 8px; }
      button { font: inherit; font-weight: 700; border: 0; border-radius: 8px; padding: 9px 14px; cursor: pointer; }
      .end { background: #d93025; color: #fff; flex: 1; }
      .ghost { background: #eee; color: #222; }
      .caution { border-left-color: #f9ab00; } .caution-dot { background: #f9ab00; }
      .high { border-left-color: #e8710a; } .high-dot { background: #e8710a; }
      .critical { border-left-color: #d93025; } .critical-dot { background: #d93025; }
      .ok-dot { background: #1e8e3e; }
      .countdown { font-weight: 700; color: #d93025; }
      .chatnote { margin-top: 8px; padding: 8px 12px; border-radius: 10px; background: #fff4e5; color: #5f3b00;
                  box-shadow: 0 2px 10px rgba(0,0,0,.25); font-size: 13px; display: flex; gap: 8px; align-items: center; }
      .chatnote button { padding: 5px 10px; white-space: nowrap; }
      .hidden { display: none; }
    </style>
    <div class="wrap hidden">
      <div class="pill"><span class="dot"></span><span class="pill-text">CallShield</span></div>
      <div class="card hidden">
        <h2 class="title"></h2>
        <div class="meta"></div>
        <ul class="reasons"></ul>
        <div class="auto hidden"></div>
        <div class="row">
          <button class="end">End call</button>
          <button class="ghost dismiss">Dismiss</button>
        </div>
      </div>
      <div class="chatnote hidden">Chat panel is closed, so CallShield can't read chat messages.
        <button class="ghost openchat">Open chat</button></div>
    </div>`;
  const $ = (sel) => root.querySelector(sel);
  const wrap = $('.wrap');
  const card = $('.card');
  $('.end').addEventListener('click', () => leaveCall(`local-${crypto.randomUUID()}`, 'manual_end_call', 'overlay'));
  $('.openchat').addEventListener('click', () => openChatPanel());
  $('.dismiss').addEventListener('click', () => {
    if (pendingAuto) cancelAuto('user_cancelled');
    card.classList.add('hidden');
  });

  function mountOverlay() {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  }

  function setPill(text, dotClass) {
    $('.pill-text').textContent = text;
    $('.dot').className = `dot ${dotClass}`;
  }

  function renderAssessment(a) {
    const level = a.risk_level;
    if (a.monitoring_state !== 'ok') {
      // Never show "safe" when monitoring is impaired.
      setPill(`CallShield: monitoring ${a.monitoring_state} - not a safety check`, '');
    } else {
      setPill(`CallShield: ${level} (${a.risk_index})${a.inference_mode === 'mock' ? ' · MOCK' : ''}`,
        level === 'normal' ? 'ok-dot' : `${level}-dot`);
    }
    if (LEVELS[level] < LEVELS.caution) {
      if (!pendingAuto) card.classList.add('hidden');
      return;
    }
    card.className = `card ${level}`;
    $('.title').textContent = {
      caution: 'Be careful: suspicious signs on this call',
      high: 'Warning: this looks like a fraud call',
      critical: 'Danger: likely digital-arrest / fraud call',
    }[level];
    $('.meta').textContent = `Risk ${a.risk_index}/100 · evidence ${a.evidence_strength}` +
      (a.inference_mode === 'mock' ? ' · MOCK detector' : '') +
      '. Real police/banks never arrest by video call or ask for OTP/money.';
    const ul = $('.reasons');
    ul.textContent = '';
    for (const r of a.reasons.slice(0, 6)) {
      const li = document.createElement('li');
      li.textContent = r;
      ul.appendChild(li);
    }
    if (lastShownAssessment !== a.assessment_id) {
      lastShownAssessment = a.assessment_id;
      chrome.runtime.sendMessage({ type: 'warning_shown', details: {
        assessment_id: a.assessment_id, risk_level: level, shown_at_ms: Date.now() } }).catch(() => {});
    }
  }

  // ---------- auto-disconnect with cancel window ----------

  function reportOutcome(actionId, actionType, status, details = {}) {
    chrome.runtime.sendMessage({ type: 'action_outcome', outcome: {
      action_id: actionId, action_type: actionType, status, details } }).catch(() => {});
  }

  function startAuto(action) {
    if (!settings.autoDisconnect) {
      reportOutcome(action.action_id, 'auto_disconnect', 'cancelled', { reason: 'not_enabled_by_user' });
      return;
    }
    if (pendingAuto || leaving) return;
    const ms = action.details?.cancel_window_ms ?? 8000;
    const deadline = Date.now() + ms;
    const box = $('.auto');
    box.classList.remove('hidden');
    card.classList.remove('hidden');
    $('.dismiss').textContent = 'Cancel auto-disconnect';
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      box.innerHTML = `<span class="countdown">Ending this call in ${left}s</span> (you enabled auto-disconnect).`;
      if (left <= 0) {
        clearInterval(pendingAuto.timer);
        pendingAuto = null;
        resetAutoUi();
        leaveCall(action.action_id, 'auto_disconnect', 'policy');
      }
    };
    pendingAuto = { actionId: action.action_id, timer: setInterval(tick, 250) };
    tick();
  }

  function resetAutoUi() {
    $('.auto').classList.add('hidden');
    $('.dismiss').textContent = 'Dismiss';
  }

  function cancelAuto(reason) {
    clearInterval(pendingAuto.timer);
    reportOutcome(pendingAuto.actionId, 'auto_disconnect', 'cancelled', { reason });
    pendingAuto = null;
    resetAutoUi();
  }

  // ---------- leave call ----------

  function findLeaveButton() {
    const buttons = document.querySelectorAll('button, [role="button"]');
    // Locale-independent first: Meet renders the Material icon ligature "call_end".
    for (const b of buttons) {
      for (const i of b.querySelectorAll('i, span')) {
        if (i.textContent.trim() === 'call_end' && i.children.length === 0) return b;
      }
    }
    for (const b of buttons) {
      if (LEAVE_LABEL.test(b.getAttribute('aria-label') || '')) return b;
    }
    return null;
  }

  async function leaveCall(actionId, actionType, origin) {
    if (leaving) return;
    leaving = true;
    const btn = findLeaveButton();
    if (!btn) {
      reportOutcome(actionId, actionType, 'failed', { origin, reason: 'leave_button_not_found' });
      leaving = false;
      return;
    }
    btn.click();
    // Verify: the leave control should disappear and stay gone.
    let goneFor = 0;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      goneFor = findLeaveButton() ? 0 : goneFor + 1;
      if (goneFor >= 4) {
        reportOutcome(actionId, actionType, 'left_meet', { origin, verified_by: 'leave_control_gone' });
        setPill('CallShield: you left the call', 'ok-dot');
        card.classList.add('hidden');
        leaving = false;
        return;
      }
    }
    reportOutcome(actionId, actionType, 'unverified', { origin, reason: 'leave_control_still_present' });
    leaving = false;
  }

  // ---------- Meet chat ingestion ----------
  // Meet only renders chat messages while the chat panel is open, so we (1) open the panel
  // when monitoring starts and nudge the user if it gets closed, and (2) also read Meet's
  // aria-live announcement regions as a best-effort fallback. Both paths share one dedupe.

  const CHAT_LABEL = /chat with everyone|^chat$|in-call messages|चैट/i;
  const seenChat = new Map(); // message id -> text
  const recentTexts = []; // { norm, t } across both paths
  const seenLive = new WeakMap(); // aria-live element -> last text
  let chatTimer = null;
  let chatCheckTimer = null;

  const norm = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();

  function isDuplicateText(text) {
    const n = norm(text);
    const now = Date.now();
    while (recentTexts.length && now - recentTexts[0].t > 120000) recentTexts.shift();
    // Announcements may wrap the message ("Rahul: <text>"), so allow containment for longer texts.
    const contains = (a, b) => b.length >= 12 && a.includes(b);
    if (recentTexts.some((r) => r.norm === n || contains(r.norm, n) || contains(n, r.norm))) return true;
    recentTexts.push({ norm: n, t: now });
    return false;
  }

  function sendChat(id, text, links, via) {
    chrome.runtime.sendMessage({ type: 'chat_message', chat: {
      message_id: id,
      t_ms: Date.now(),
      text: text.slice(0, 4000),
      sender_role: 'unknown', // Meet's DOM does not reliably expose who sent it
      sender_label: via,
      links,
    } }).catch(() => {});
  }

  function findChatButton() {
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      if (host.contains(b)) continue;
      const label = b.getAttribute('aria-label') || b.getAttribute('data-tooltip') || '';
      if (CHAT_LABEL.test(label)) return b;
      for (const i of b.querySelectorAll('i, span')) {
        const t = i.textContent.trim();
        if ((t === 'chat' || t === 'chat_bubble') && i.children.length === 0) return b;
      }
    }
    return null;
  }

  // true = open, false = closed, null = can't tell
  function chatPanelOpen() {
    const b = findChatButton();
    if (!b) return null;
    const pressed = b.getAttribute('aria-pressed');
    if (pressed === 'true') return true;
    if (pressed === 'false') return false;
    return null;
  }

  function openChatPanel() {
    if (chatPanelOpen() === true) return;
    const b = findChatButton();
    if (b) b.click();
    setTimeout(checkChatPanel, 800);
  }

  function checkChatPanel() {
    if (!monitoring) return;
    $('.chatnote').classList.toggle('hidden', chatPanelOpen() !== false);
  }

  function scanChat() {
    chatTimer = null;
    if (!monitoring) return;
    for (const el of document.querySelectorAll('[data-message-id]')) {
      const id = el.getAttribute('data-message-id');
      const text = (el.innerText || '').trim();
      if (!id || !text || seenChat.get(id) === text) continue;
      const edited = seenChat.has(id);
      seenChat.set(id, text);
      if (!edited && isDuplicateText(text)) continue;
      const links = [...el.querySelectorAll('a[href]')].map((a) => a.href).slice(0, 10);
      sendChat(edited ? `${id}#${seenChat.size}` : id, text, links, 'chat_panel');
    }
    for (const el of document.querySelectorAll('[aria-live]')) {
      if (host.contains(el)) continue;
      const text = (el.innerText || '').trim();
      if (!text || text.length < 3 || seenLive.get(el) === text) continue;
      seenLive.set(el, text);
      if (isDuplicateText(text)) continue;
      const links = [...el.querySelectorAll('a[href]')].map((a) => a.href).slice(0, 10);
      sendChat(`live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, links, 'meet_announcement');
    }
  }

  const observer = new MutationObserver(() => {
    if (monitoring && !chatTimer) chatTimer = setTimeout(scanChat, 300);
  });

  // ---------- wiring ----------

  function setMonitoring(active, s) {
    monitoring = active;
    settings = s || {};
    if (active) {
      mountOverlay();
      wrap.classList.remove('hidden');
      setPill('CallShield: connecting…', '');
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      if (settings.keepChatOpen !== false) openChatPanel();
      scanChat();
      clearInterval(chatCheckTimer);
      chatCheckTimer = setInterval(checkChatPanel, 3000);
    } else {
      observer.disconnect();
      clearInterval(chatCheckTimer);
      $('.chatnote').classList.add('hidden');
      if (pendingAuto) cancelAuto('monitoring_stopped');
      wrap.classList.add('hidden');
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'monitoring') {
      setMonitoring(msg.active, msg.settings);
    } else if (msg.type === 'backend_message' && monitoring) {
      const ev = msg.msg;
      if (ev.event_type === 'assessment') {
        renderAssessment(ev.payload);
      } else if (ev.event_type === 'action') {
        const a = ev.payload;
        if (a.action_type === 'auto_disconnect' && a.status === 'pending') startAuto(a);
        if (a.action_type === 'auto_disconnect' && a.status === 'cancelled' && pendingAuto) {
          cancelAuto(`backend: ${a.details?.reason || 'cancelled'}`);
        }
        if (a.action_type === 'manual_end_call' && a.status === 'requested') leaveCall(a.action_id, 'manual_end_call', 'dashboard');
      }
    }
    return false;
  });

  chrome.runtime.sendMessage({ type: 'content_ready' })
    .then((r) => { if (r && r.active) setMonitoring(true, r.settings); })
    .catch(() => {});
})();
