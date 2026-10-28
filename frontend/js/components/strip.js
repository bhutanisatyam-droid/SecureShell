// CallShield Top Telemetry Ribbon Component
// Real-time operational device & pipeline status strip.

import { esc } from '../formatters.js';

export class TelemetryStripComponent {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
  }

  render(health = null) {
    if (!health) {
      this.container.innerHTML = `
        <div class="strip-empty">
          <span class="muted small">Select an active session to monitor real-time device capture telemetry.</span>
        </div>
      `;
      return;
    }

    const cs = health.capture_status || {};
    const ageMs = (k) => (health.media_age_ms ? health.media_age_ms[k] : undefined);
    const fresh = (k, threshold = 2000) => ageMs(k) != null && ageMs(k) < threshold;
    const ageTxt = (k) => {
      const ms = ageMs(k);
      if (ms == null) return 'no packets';
      if (ms < 1000) return 'active (<1s)';
      return `${(ms / 1000).toFixed(1)}s ago`;
    };

    const isLive = Boolean(health.active && health.extension_connected);

    const items = [
      {
        name: 'Extension MV3',
        status: !isLive ? 'off' : health.session_start_received ? 'on' : 'warn',
        detail: !health.active ? 'Session ended' : !health.extension_connected ? 'Disconnected' : health.session_start_received ? 'Active & Synced' : 'Settings pending',
        icon: '🔌',
      },
      {
        name: 'Meet Tab Audio',
        status: isLive && fresh('meet_tab', 3000) ? 'on' : 'off',
        detail: `${health.counters?.audio_chunks_meet_tab || 0} chunks · ${ageTxt('meet_tab')}`,
        icon: '🔊',
      },
      {
        name: 'Tab Video Capture',
        status: isLive && fresh('video', 6000) ? 'on' : 'off',
        detail: `${health.counters?.video_frames || 0} frames · ${ageTxt('video')}`,
        icon: '📹',
      },
      {
        name: 'User Mic (Local)',
        status: cs.local_mic === 'off' || !cs.local_mic ? 'idle' : isLive && fresh('local_mic', 3000) ? 'on' : 'warn',
        detail: cs.local_mic === 'capturing' ? `${health.counters?.audio_chunks_local_mic || 0} chunks` : (cs.local_mic || 'Disabled (opt-in)'),
        icon: '🎙',
      },
      {
        name: 'Meet Chat Ingest',
        status: (health.counters?.chat_messages || 0) > 0 ? 'on' : 'idle',
        detail: `${health.counters?.chat_messages || 0} messages tracked`,
        icon: '💬',
      },
      {
        name: 'AI Inference Pipeline',
        status: health.pipeline?.ok ? (health.inference_mode === 'mock' ? 'warn' : 'on') : 'off',
        detail: health.inference_mode === 'mock' ? 'MOCK (Keyword baseline)' : `${health.pipeline?.name || 'Live LLM'}`,
        icon: '🧠',
      },
      {
        name: 'Monitoring Integrity',
        status: health.monitoring_state === 'ok' ? 'on' : health.monitoring_state === 'degraded' ? 'warn' : 'off',
        detail: (health.monitoring_state || 'unknown').toUpperCase(),
        icon: '🛡',
      },
    ];

    this.container.innerHTML = `
      <div class="telemetry-strip">
        ${items.map(it => `
          <div class="telemetry-pill status-${it.status}" title="${esc(it.name)}: ${esc(it.detail)}">
            <span class="pill-dot"></span>
            <span class="pill-icon">${it.icon}</span>
            <div class="pill-info">
              <span class="pill-title">${esc(it.name)}</span>
              <span class="pill-detail">${esc(it.detail)}</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }
}

