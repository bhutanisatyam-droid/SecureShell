// CallShield Video Analysis Component
// Displays the latest frame examined by the Gemini vision model (documents, uniforms, emblems)

import { esc, fmtTime } from '../formatters.js';

export class VisionComponent {
  constructor(containerId, api) {
    this.container = document.getElementById(containerId);
    this.api = api;
    this.sessionId = null;
    this.lastVisionEvent = null;
    this.pollTimer = null;
    this.render();
  }

  render() {
    if (!this.container) return;
    this.container.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-wrap">
          <h3 class="panel-title">Video Analysis</h3>
          <span class="muted small text-muted text-xs">(reports what is shown, never whether it is genuine)</span>
        </div>
      </div>
      <div class="vision">
        <img id="visionImg" alt="Last analysed video frame" class="hidden" />
        <div id="visionInfo" class="muted text-muted">No frame analysed yet.</div>
      </div>
    `;
  }

  setSession(sessionId) {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.lastVisionEvent = null;
    const img = document.getElementById('visionImg');
    const info = document.getElementById('visionInfo');
    if (img) {
      img.classList.add('hidden');
      img.src = '';
    }
    if (info) {
      info.textContent = 'No frame analysed yet.';
    }

    this.stopPolling();
    if (this.sessionId) {
      this.refresh();
      this.startPolling();
    }
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.refresh();
    }, 3000);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async refresh() {
    if (!this.sessionId) return;
    const img = document.getElementById('visionImg');
    const info = document.getElementById('visionInfo');
    if (!img || !info) return;

    let v;
    try {
      v = await this.api.getVisionLatest(this.sessionId);
    } catch {
      return;
    }

    if (!v || !v.available) {
      img.classList.add('hidden');
      info.textContent = 'No frame analysed yet (needs GEMINI_API_KEY; frames are checked when the picture changes, and once a minute).';
      this.lastVisionEvent = null;
      return;
    }

    if (v.event_id === this.lastVisionEvent) return;
    this.lastVisionEvent = v.event_id;

    const token = this.api.getToken();
    img.src = `/api/sessions/${encodeURIComponent(this.sessionId)}/vision/latest.jpg?token=${encodeURIComponent(token)}&e=${encodeURIComponent(v.event_id)}`;
    img.classList.remove('hidden');

    const docs = (v.documents || []).map((d) => {
      const kindStr = esc((d.kind || '').replace(/_/g, ' '));
      const agencyStr = d.agency ? ` <span class="muted text-muted">(${esc(d.agency)})</span>` : '';
      const textStr = d.text ? `<pre>${esc(d.text)}</pre>` : '';
      return `<div class="doc"><b>${kindStr}</b>${agencyStr}${textStr}</div>`;
    }).join('');

    const cues = (v.cues && v.cues.length)
      ? `<div>Cues: ${v.cues.map((c) => `<span class="tag tag-video">${esc((c || '').replace(/_/g, ' '))}</span>`).join(' ')}</div>`
      : '';

    info.innerHTML = `
      <div class="muted small text-muted text-xs mb-2">${fmtTime(v.t_ms)} · ${v.latency_ms ?? 0} ms · confidence ${esc(v.confidence ?? '–')}</div>
      ${docs || cues ? docs + cues : '<div>Nothing relevant visible.</div>'}
    `;
  }
}
