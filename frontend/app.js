// CallShield dashboard: REST for snapshots and commands, WebSocket for live events.
(() => {
  const params = new URLSearchParams(location.search);
  let token = params.get('token') || localStorage.getItem('cs_token') || 'dev-token';
  try { localStorage.setItem('cs_token', token); } catch {}

  const $ = (id) => document.getElementById(id);
  const api = (path, opts = {}) => fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  }).then(async (r) => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); });

  let selected = params.get('session');
  const sessions = new Map(); // id -> { health, level, index }
  let view = null; // { events: [], evidenceByRef: Map }

  const fmtTime = (ms) => new Date(ms).toLocaleTimeString();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- sessions list ----------

  function renderSessions() {
    const ul = $('sessions');
    ul.textContent = '';
    for (const [id, s] of sessions) {
      const li = document.createElement('li');
      li.className = id === selected ? 'sel' : '';
      const live = s.health && s.health.active ? (s.health.extension_connected ? 'live' : 'disconnected') : 'ended';
      li.innerHTML = `<div class="lvl">${esc(s.level || '–')} ${s.index != null ? `(${s.index})` : ''}</div>${esc(id)}<div class="muted small">${live}</div>`;
      li.onclick = () => select(id);
      ul.appendChild(li);
    }
  }

  async function loadSessions() {
    const list = await api(`/api/sessions`);
    for (const row of list) {
      const cur = sessions.get(row.session_id) || {};
      sessions.set(row.session_id, { ...cur, health: row.live || cur.health || { active: !row.ended_ms } });
    }
    renderSessions();
    if (!selected && list.length) select(list[0].session_id);
  }

  async function select(id) {
    selected = id;
    renderSessions();
    const d = await api(`/api/sessions/${encodeURIComponent(id)}`);
    view = { events: [], transfers: d.transfers };
    $('empty').classList.add('hidden');
    $('view').classList.remove('hidden');
    for (const ev of d.events) addEvent(ev, false);
    renderAll(d.health);
  }

  // ---------- event handling ----------

  function addEvent(ev, live = true) {
    view.events.push(ev);
    if (ev.event_type === 'assessment') {
      const s = sessions.get(ev.session_id) || {};
      s.level = ev.payload.risk_level; s.index = ev.payload.risk_index;
      sessions.set(ev.session_id, s);
    }
    if (live) renderAll();
  }

  function latest(type) {
    for (let i = view.events.length - 1; i >= 0; i--) if (view.events[i].event_type === type) return view.events[i];
    return null;
  }

  function renderAll(health) {
    if (health) { const s = sessions.get(selected) || {}; s.health = health; sessions.set(selected, s); }
    renderRisk();
    renderHealth();
    renderTranscript();
    renderEvidence();
    renderActions();
    renderTransfers();
    renderSessions();
  }

  function renderRisk() {
    const a = latest('assessment');
    const panel = $('riskPanel');
    const h = (sessions.get(selected) || {}).health || {};
    $('reportMd').href = `/api/sessions/${encodeURIComponent(selected)}/report?format=md&token=${encodeURIComponent(token)}`;
    $('reportJson').href = `/api/sessions/${encodeURIComponent(selected)}/report?token=${encodeURIComponent(token)}`;
    if (!a) {
      panel.className = 'panel risk';
      $('riskIndex').textContent = '–'; $('riskLevel').textContent = 'no assessment';
      $('monitoring').className = 'monitoring unavailable';
      $('monitoring').textContent = 'No assessment yet: this is NOT a safe result.';
      $('reasons').textContent = ''; $('patterns').textContent = ''; $('gate').textContent = '';
      $('inference').textContent = '';
      return;
    }
    const p = a.payload;
    const impaired = p.monitoring_state !== 'ok';
    panel.className = `panel risk ${impaired && p.risk_level === 'normal' ? 'unavailable' : p.risk_level}`;
    $('riskIndex').textContent = p.risk_index;
    $('riskLevel').textContent = p.risk_level;
    $('inference').textContent = p.inference_mode === 'mock' ? 'MOCK DETECTOR' : `inference: ${p.inference_mode}`;
    $('inference').className = `badge ${p.inference_mode === 'mock' ? 'warn' : p.inference_mode === 'live' ? 'ok' : 'bad'}`;
    $('monitoring').className = `monitoring ${p.monitoring_state}`;
    $('monitoring').textContent = impaired
      ? `Monitoring ${p.monitoring_state.toUpperCase()}: a low score here does not mean the call is safe.`
      : 'Monitoring OK';
    const lat = p.latency_ms && p.latency_ms.evidence_end_to_assessment_ms;
    $('strength').textContent = `Evidence strength: ${p.evidence_strength} · config ${p.config_version}` +
      (lat != null ? ` · evidence→assessment ${lat} ms` : '');
    $('patterns').innerHTML = p.patterns.map((x) => `<span class="chip">${esc(x.replace('_', ' '))}</span>`).join('');
    $('reasons').innerHTML = p.reasons.map((r) => `<li>${esc(r)}</li>`).join('') || '<li class="muted">No fraud indicators yet.</li>';
    const labels = {
      user_opted_in: 'User opted in', level_critical: 'Risk level critical', sustained: 'Critical sustained',
      corroborated: 'Corroborated by ≥3 behaviours', strong_category: 'Includes a strongest-class signal',
      monitoring_ok: 'Monitoring healthy', live_inference: 'Live (non-mock) inference',
    };
    $('gate').innerHTML = Object.entries(p.policy_gate || {})
      .map(([k, v]) => `<li class="${v ? 'pass' : ''}">${esc(labels[k] || k)}</li>`).join('');
    $('endCall').disabled = !(h.active && h.extension_connected);
  }

  function renderStrip(h) {
    const cs = h.capture_status || {};
    const ageMs = (k) => (h.media_age_ms ? h.media_age_ms[k] : undefined);
    const fresh = (k) => ageMs(k) != null && ageMs(k) < 2000;
    const ageTxt = (k) => (ageMs(k) == null ? 'nothing yet' : `${(ageMs(k) / 1000).toFixed(1)}s ago`);
    const live = h.active && h.extension_connected;
    const caps = [
      ['Extension', !live ? 'off' : h.session_start_received ? 'on' : 'warn',
        !h.active ? 'session ended' : !h.extension_connected ? 'disconnected'
          : h.session_start_received ? 'connected' : 'connected, settings NOT received'],
      ['Tab audio', live && fresh('meet_tab') ? 'on' : 'off', `${h.counters?.audio_chunks_meet_tab || 0} chunks · ${ageTxt('meet_tab')}`],
      ['Video', live && ageMs('video') != null && ageMs('video') < 5000 ? 'on' : 'off', `${h.counters?.video_frames || 0} frames · ${ageTxt('video')}`],
      ['Mic (you)', cs.local_mic === 'off' || !cs.local_mic ? 'idle' : live && fresh('local_mic') ? 'on' : 'warn',
        cs.local_mic === 'capturing' ? `${h.counters?.audio_chunks_local_mic || 0} chunks · ${ageTxt('local_mic')}` : (cs.local_mic || 'off')],
      ['Chat', (h.counters?.chat_messages || 0) > 0 ? 'on' : 'idle', `${h.counters?.chat_messages || 0} messages`],
      ['Detector', h.pipeline?.ok ? (h.inference_mode === 'mock' ? 'warn' : 'on') : 'off',
        h.inference_mode === 'mock' ? 'MOCK (no ASR)' : `${h.inference_mode}`],
      ['Monitoring', h.monitoring_state === 'ok' ? 'on' : 'off', h.monitoring_state],
    ];
    $('strip').innerHTML = caps.map(([name, cls, txt]) =>
      `<div class="cap ${cls}"><i class="d"></i><div><b>${esc(name)}</b><span>${esc(txt)}</span></div></div>`).join('');
  }

  function renderHealth() {
    const h = (sessions.get(selected) || {}).health;
    if (!h) { $('health').innerHTML = '<dt>status</dt><dd>unknown</dd>'; $('strip').textContent = ''; return; }
    renderStrip(h);
    const cs = h.capture_status || {};
    const age = (k) => (h.media_age_ms && h.media_age_ms[k] != null ? `${Math.round(h.media_age_ms[k] / 100) / 10}s ago` : 'none');
    const rows = [
      ['Session', h.active ? 'active' : 'ended'],
      ['Extension', h.extension_connected ? 'connected' : 'disconnected'],
      ['Monitoring', h.monitoring_state],
      ['Pipeline', `${h.pipeline?.name} (${h.pipeline?.ok ? 'ok' : 'NOT OK'})${h.pipeline?.detail ? ` – ${h.pipeline.detail}` : ''}`],
      ['Last pipeline error', h.pipeline?.last_error || '–'],
      ['Tab audio', `${cs.tab_audio || '?'} · last chunk ${age('meet_tab')}`],
      ['Local mic', `${cs.local_mic || '?'} · last chunk ${age('local_mic')}`],
      ['Video frames', `${cs.video || '?'} · last ${age('video')} · ${h.counters?.video_frames || 0} received`],
      ['Chat messages', h.counters?.chat_messages || 0],
      ['Utterances / evidence', `${h.counters?.utterances || 0} / ${h.counters?.evidence || 0}`],
      ['Dropped (audio/video)', `${h.counters?.audio_dropped || 0} / ${h.counters?.video_dropped || 0} backend · ` +
        `${(cs.counters?.audio_dropped_meet_tab || 0)} / ${(cs.counters?.video_dropped || 0)} extension`],
      ['Auto-disconnect', !h.session_start_received ? 'unknown (extension settings not received)'
        : h.settings?.auto_disconnect ? 'enabled by user' : 'off'],
      ['Bank freeze', h.bank_frozen ? 'FROZEN (simulated)' : 'no'],
    ];
    const rejected = Object.entries(h.counters || {}).filter(([k]) => k.startsWith('rejected_'));
    if (rejected.length) rows.push(['Rejected events', rejected.map(([k, v]) => `${k.slice(9)}: ${v}`).join(', ')]);
    $('health').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  }

  // evidence_id -> reason, for evidence the model withdrew after later context
  function retractions() {
    const out = new Map();
    for (const e of view.events) {
      if (e.event_type !== 'retraction') continue;
      for (const id of e.payload.evidence_ids) out.set(id, e.payload.reason);
    }
    return out;
  }

  function renderTranscript() {
    const flagged = new Map();
    const retracted = retractions();
    for (const e of view.events) {
      if (e.event_type !== 'evidence' || retracted.has(e.payload.evidence_id)) continue;
      for (const r of e.payload.source_event_ids) {
        if (!flagged.has(r)) flagged.set(r, []);
        flagged.get(r).push(e.payload.category);
      }
    }
    const items = view.events.filter((e) => e.event_type === 'utterance' || e.event_type === 'chat_message');
    $('transcript').innerHTML = items.slice(-200).map((e) => {
      const p = e.payload;
      const isChat = e.event_type === 'chat_message';
      const cats = flagged.get(e.event_id) || [];
      const who = isChat ? p.sender_role : p.speaker_role;
      return `<div class="item ${cats.length ? 'flagged' : ''}"><span class="t">${fmtTime(e.timestamp_ms)}</span>` +
        `<span class="tag">${isChat ? 'chat' : 'speech'}</span><span class="tag">${esc(who)}</span>` +
        (p.is_mock ? '<span class="tag mock">injected</span>' : '') +
        cats.map((c) => `<span class="tag flag">${esc(c)}</span>`).join('') +
        `<div>${esc(p.text)}</div></div>`;
    }).join('') || '<p class="muted">No transcript yet.</p>';
    $('transcript').scrollTop = 1e9;
  }

  function renderEvidence() {
    const items = view.events.filter((e) => e.event_type === 'evidence');
    const retracted = retractions();
    $('evidence').innerHTML = items.slice(-100).reverse().map((e) => {
      const p = e.payload;
      const why = retracted.get(p.evidence_id);
      return `<div class="item ${why ? 'retracted' : ''}"><span class="t">${fmtTime(p.t_end_ms)}</span><b>${esc(p.category)}</b> ` +
        (why ? `<span class="tag">retracted: ${esc(why)}</span> ` : '') +
        `<span class="tag">${esc(p.source_modality)}</span>${p.is_mock ? '<span class="tag mock">mock</span>' : ''}` +
        `${p.rule_refs.length ? `<span class="muted small">${esc(p.rule_refs.join(', '))}</span>` : ''}` +
        `${p.quality != null ? ` <span class="muted small">q=${p.quality}</span>` : ''}` +
        `<div class="muted">“${esc(p.quoted_text_or_observation)}”</div></div>`;
    }).join('') || '<p class="muted">No evidence yet.</p>';
  }

  function renderActions() {
    const items = view.events.filter((e) => e.event_type === 'action');
    $('actions').innerHTML = items.slice(-50).reverse().map((e) => {
      const p = e.payload;
      return `<div class="item"><span class="t">${fmtTime(e.timestamp_ms)}</span><b>${esc(p.action_type)}</b> → ${esc(p.status)} ` +
        `<span class="tag">${esc(e.source)}</span>${p.action_type === 'bank_hold' ? '<span class="tag mock">simulated</span>' : ''}` +
        `${p.details && (p.details.reason || p.details.note) ? `<div class="muted small">${esc(p.details.reason || p.details.note)}</div>` : ''}</div>`;
    }).join('') || '<p class="muted">No actions.</p>';
  }

  function renderTransfers() {
    $('transfers').innerHTML = (view.transfers || []).map((t) =>
      `<tr><td>${fmtTime(t.created_ms)}</td><td>${Number(t.amount).toLocaleString('en-IN')}</td><td>${esc(t.payee)}</td>` +
      `<td class="st-${t.status}">${t.status}</td><td>${esc(t.reason)}</td>` +
      `<td>${t.status === 'HOLD' ? `<button class="ghost" data-release="${t.transfer_id}">Release</button>` : ''}</td></tr>`
    ).join('') || '<tr><td colspan="6" class="muted">No simulated transfers.</td></tr>';
  }

  async function refreshTransfers() {
    if (!selected) return;
    view.transfers = await api(`/api/bank/transfers?session_id=${encodeURIComponent(selected)}`);
    renderTransfers();
  }

  // ---------- controls ----------

  $('endCall').onclick = async () => {
    if (!confirm('Ask the extension to leave this Meet call now?')) return;
    try { await api(`/api/sessions/${encodeURIComponent(selected)}/end_call`, { method: 'POST' }); }
    catch (e) { alert(`End call failed: ${e.message}`); }
  };

  $('inject').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('injectText').value.trim();
    if (!text) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(selected)}/inject_text`, {
        method: 'POST', body: JSON.stringify({ text, speaker_role: $('injectRole').value }) });
      $('injectText').value = '';
    } catch (err) { alert(err.message); }
  };

  $('transfer').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/bank/transfers', { method: 'POST', body: JSON.stringify({
        session_id: selected, amount: Number($('amount').value), payee: $('payee').value }) });
      refreshTransfers();
    } catch (err) { alert(err.message); }
  };

  $('transfers').onclick = async (e) => {
    const id = e.target.dataset && e.target.dataset.release;
    if (!id) return;
    await api(`/api/bank/transfers/${id}/release`, { method: 'POST' });
    refreshTransfers();
  };

  // ---------- live socket ----------

  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/dashboard?token=${encodeURIComponent(token)}`);
    ws.onopen = () => { $('conn').textContent = 'live'; $('conn').className = 'badge ok'; loadSessions().catch(console.error); };
    ws.onclose = () => { $('conn').textContent = 'disconnected – retrying'; $('conn').className = 'badge bad'; setTimeout(connect, 2000); };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.kind === 'health') {
        const s = sessions.get(msg.session_id) || {};
        const isNew = !sessions.has(msg.session_id);
        s.health = msg.health;
        sessions.set(msg.session_id, s);
        if (isNew && !selected) select(msg.session_id);
        if (msg.session_id === selected && view) { renderHealth(); renderRisk(); }
        renderSessions();
      } else if (msg.kind === 'event') {
        if (!sessions.has(msg.session_id)) { sessions.set(msg.session_id, {}); renderSessions(); }
        if (msg.session_id === selected && view) {
          addEvent(msg.event);
          if (msg.event.event_type === 'action' && msg.event.payload.action_type === 'bank_hold') refreshTransfers();
        } else if (msg.event.event_type === 'assessment') {
          const s = sessions.get(msg.session_id);
          s.level = msg.event.payload.risk_level; s.index = msg.event.payload.risk_index;
          renderSessions();
        }
      }
    };
  }

  setInterval(refreshTransfers, 3000);
  connect();
})();
