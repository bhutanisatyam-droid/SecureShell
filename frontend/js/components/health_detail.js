// CallShield Deep Diagnostic & Actions Ledger Component

import { esc, fmtTime } from '../formatters.js';

export class DiagnosticsComponent {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
  }

  render(health = null, events = []) {
    const actions = events.filter(e => e.event_type === 'action');
    const reversedActions = [...actions].reverse();

    if (!health) {
      this.container.innerHTML = `
        <div class="panel-header">
          <h3 class="panel-title">Diagnostic Telemetry &amp; Actions</h3>
        </div>
        <p class="muted p-4">No active session selected.</p>
      `;
      return;
    }

    const cs = health.capture_status || {};
    const age = (k) => (health.media_age_ms && health.media_age_ms[k] != null ? `${Math.round(health.media_age_ms[k] / 100) / 10}s` : '–');

    const diagRows = [
      ['Session State', health.active ? 'ACTIVE' : 'ENDED'],
      ['Extension Sync', health.extension_connected ? 'CONNECTED' : 'DISCONNECTED'],
      ['Monitoring Health', (health.monitoring_state || '').toUpperCase()],
      ['Pipeline Engine', `${health.pipeline?.name} (${health.pipeline?.ok ? 'HEALTHY' : 'FAILED'})`],
      ['Last Pipeline Error', health.pipeline?.last_error || 'None'],
      ['LLM Failover', (health.pipeline?.llm_backends || []).map(b => `${b.backend}: ${b.state}`).join(' · ') || 'None configured'],
      ['Vision', (() => {
        const v = health.pipeline?.vision;
        if (!v || !v.enabled) return 'Disabled (no GEMINI_API_KEY)';
        return `${v.model || 'Gemini'} (${v.state || 'ready'}) · ${v.calls || 0} calls · ${v.failures || 0} failures`;
      })()],
      ['Audio / Video Latency', `Tab Audio: ${age('meet_tab')} | Video: ${age('video')} | Mic: ${age('local_mic')}`],
      ['Packet Counters', `Frames: ${health.counters?.video_frames || 0} | Utterances: ${health.counters?.utterances || 0} | Evidence: ${health.counters?.evidence || 0}`],
      ['Ingest Queues', `Audio: ${health.queues?.audio || 0}/200 | Video: ${health.queues?.video || 0}/2 | Text: ${health.queues?.text || 0}/200`],
      ['Dropped Packets', `Audio: ${health.counters?.audio_dropped || 0} backend | Video: ${health.counters?.video_dropped || 0} backend`],
      ['Auto-Disconnect Setting', !health.session_start_received ? 'Unknown (extension settings not received)' : health.settings?.auto_disconnect ? 'Opted-in by user' : 'Disabled by user'],
      ['Simulated Bank Hold', health.bank_frozen ? 'FROZEN (Simulated hold on transfers)' : 'Inactive'],
    ];

    const rejected = Object.entries(health.counters || {}).filter(([k]) => k.startsWith('rejected_'));
    if (rejected.length > 0) {
      diagRows.push(['Rejected Events', rejected.map(([k, v]) => `${k.slice(9)}: ${v}`).join(', ')]);
    }

    this.container.innerHTML = `
      <div class="panel-header">
        <h3 class="panel-title">Diagnostic Telemetry &amp; Actions</h3>
        <span class="badge badge-subtle">Engine Health</span>
      </div>

      <div class="diag-split">
        <div class="diag-half">
          <h4 class="diag-subtitle">Operational Health Grid</h4>
          <dl class="kv-grid">
            ${diagRows.map(([k, v]) => `
              <div class="kv-row">
                <dt class="kv-key">${esc(k)}</dt>
                <dd class="kv-val">${esc(v)}</dd>
              </div>
            `).join('')}
          </dl>
        </div>

        <div class="diag-half">
          <h4 class="diag-subtitle">Policy Actions Ledger (${actions.length})</h4>
          <div class="actions-feed">
            ${reversedActions.length === 0 ? `
              <div class="empty-feed-compact"><p class="muted">No policy actions executed.</p></div>
            ` : ''}
            ${reversedActions.map(a => {
              const p = a.payload;
              const statusClass = {
                requested: 'status-warn',
                pending: 'status-warn',
                left_meet: 'status-ok',
                simulated: 'status-muted',
                done: 'status-ok',
                failed: 'status-danger',
                cancelled: 'status-muted',
              }[p.status] || 'status-muted';

              return `
                <div class="action-item">
                  <div class="action-top">
                    <span class="action-time">${fmtTime(a.timestamp_ms)}</span>
                    <span class="action-type"><b>${esc(p.action_type)}</b></span>
                    <span class="status-pill ${statusClass}">${esc(p.status)}</span>
                    <span class="tag">${esc(a.source)}</span>
                  </div>
                  ${p.details && (p.details.reason || p.details.note) ? `
                    <div class="action-detail">${esc(p.details.reason || p.details.note)}</div>
                  ` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  }
}

