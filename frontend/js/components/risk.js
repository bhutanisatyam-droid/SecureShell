// CallShield Risk Assessment & Threat Gauge Component

import { esc, getRiskColorClass } from '../formatters.js';

export class RiskComponent {
  constructor(containerId, onEndCall, onOpenChakshu, onOpenReport) {
    this.container = document.getElementById(containerId);
    this.onEndCall = onEndCall;
    this.onOpenChakshu = onOpenChakshu;
    this.onOpenReport = onOpenReport;
  }

  render(assessment, sessionHealth, activeSessionId, token) {
    if (!assessment) {
      this._renderNoAssessment(sessionHealth);
      return;
    }

    const p = assessment.payload;
    const h = sessionHealth || {};
    const riskLevel = p.risk_level || 'normal';
    const riskIndex = p.risk_index ?? 0;
    const monitoringState = p.monitoring_state || 'unavailable';
    const isImpaired = monitoringState !== 'ok';
    const colorClass = getRiskColorClass(riskLevel, monitoringState);

    // SVG circular gauge calculation (circumference for r=54 is ~339.29)
    const radius = 54;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (circumference * (riskIndex / 100));

    const policyLabels = {
      user_opted_in: 'User Opted In for Auto-Disconnect',
      level_critical: 'Risk Level Sustained at Critical',
      sustained: 'Critical Risk Sustained Duration Met',
      corroborated: 'Corroborated by ≥3 Suspicious Behaviours',
      strong_category: 'Includes Highest-Class Threat Signal',
      monitoring_ok: 'Monitoring Pipeline Healthy (Unimpaired)',
      live_inference: 'Live Inference (Non-Mock Detector)',
    };

    const inferencePill = {
      live: '<span class="badge badge-ok">LIVE INFERENCE (Sarvam + LLM)</span>',
      mock: '<span class="badge badge-warn">MOCK DETECTOR (Keyword Heuristics)</span>',
      none: '<span class="badge badge-muted">NO INFERENCE</span>',
    }[p.inference_mode] || `<span class="badge">${esc(p.inference_mode)}</span>`;

    const canEndCall = Boolean(h.active && h.extension_connected);

    this.container.innerHTML = `
      <div class="risk-card ${colorClass}">
        <div class="risk-header">
          <div class="risk-title-block">
            <span class="label-upper">Real-Time Threat Level</span>
            <div class="risk-level-badge risk-bg-${colorClass}">
              ${esc(riskLevel.toUpperCase())}
            </div>
          </div>
          <div class="risk-inference-block">
            ${inferencePill}
            <span class="config-tag">config: ${esc(p.config_version || 'v1')}</span>
          </div>
        </div>

        <div class="risk-gauge-row">
          <div class="gauge-container">
            <svg class="risk-circle-svg" viewBox="0 0 130 130" width="130" height="130">
              <circle class="gauge-bg" cx="65" cy="65" r="${radius}" stroke-width="12" />
              <circle class="gauge-bar gauge-${colorClass}" cx="65" cy="65" r="${radius}" stroke-width="12"
                stroke-dasharray="${circumference}" stroke-dashoffset="${strokeDashoffset}" stroke-linecap="round" />
            </svg>
            <div class="gauge-label">
              <span class="gauge-val">${riskIndex}</span>
              <span class="gauge-max">/ 100</span>
            </div>
          </div>

          <div class="gauge-meta">
            <div class="monitoring-banner state-${monitoringState}">
              <span class="state-dot"></span>
              <b>${isImpaired ? `MONITORING ${monitoringState.toUpperCase()}` : 'MONITORING FULLY OPERATIONAL'}</b>
              <div class="state-sub">
                ${isImpaired
                  ? 'Pipeline is degraded or disconnected. A low score here does NOT confirm the call is safe.'
                  : 'Tab audio capture and AI evaluation streaming without lag.'}
              </div>
            </div>

            <div class="meta-pills">
              <div class="meta-pill">
                <span class="lbl">Evidence Strength:</span>
                <span class="val font-semibold">${esc(p.evidence_strength || 'none')}</span>
              </div>
              ${p.latency_ms && p.latency_ms.evidence_end_to_assessment_ms != null ? `
                <div class="meta-pill">
                  <span class="lbl">Evidence → Score Latency:</span>
                  <span class="val">${p.latency_ms.evidence_end_to_assessment_ms} ms</span>
                </div>
              ` : ''}
            </div>

            <div class="patterns-wrap">
              <span class="patterns-label">Active Threat Patterns:</span>
              <div class="pattern-chips">
                ${(p.patterns || []).length === 0 ? '<span class="text-muted small">No coordinated pattern triggered</span>' : ''}
                ${(p.patterns || []).map(pt => `<span class="pattern-chip">⚡ ${esc(pt.replace(/_/g, ' '))}</span>`).join('')}
              </div>
            </div>
          </div>
        </div>

        <div class="reasons-block">
          <h4 class="reasons-heading">Threat Indicators &amp; Detected Motives</h4>
          <ul class="reasons-list">
            ${(p.reasons || []).length === 0 ? '<li class="text-muted">No suspicious indicators recorded yet for this session.</li>' : ''}
            ${(p.reasons || []).map(r => `<li><span class="reason-bullet">▸</span> <span>${esc(r)}</span></li>`).join('')}
          </ul>
        </div>

        <div class="gate-block">
          <h4 class="gate-heading">Auto-Disconnect Safety Gate (All conditions required)</h4>
          <div class="gate-grid">
            ${Object.entries(p.policy_gate || {}).map(([k, pass]) => `
              <div class="gate-item ${pass ? 'gate-pass' : 'gate-fail'}">
                <span class="gate-icon">${pass ? '✓' : '✗'}</span>
                <span class="gate-text">${esc(policyLabels[k] || k)}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="actions-toolbar">
          <button class="btn btn-danger" id="btnEndCall" ${canEndCall ? '' : 'disabled'} title="${canEndCall ? 'Leave Google Meet Call' : 'Requires active extension connection'}">
            <span class="btn-icon">⏹</span> End Meet Call Now
          </button>
          <button class="btn btn-secondary" id="btnChakshuReport">
            <span class="btn-icon">🛡</span> Report to Chakshu
          </button>
          <button class="btn btn-outline" id="btnIncidentReport">
            <span class="btn-icon">📄</span> Incident Report
          </button>
        </div>
      </div>
    `;

    this._bindEvents(activeSessionId, token);
  }

  _renderNoAssessment(sessionHealth) {
    const h = sessionHealth || {};
    const canEndCall = Boolean(h.active && h.extension_connected);

    this.container.innerHTML = `
      <div class="risk-card unavailable">
        <div class="risk-header">
          <div class="risk-title-block">
            <span class="label-upper">Real-Time Threat Level</span>
            <div class="risk-level-badge risk-bg-unavailable">NO ASSESSMENT AVAILABLE</div>
          </div>
          <div class="risk-inference-block">
            <span class="badge badge-muted">Awaiting Data</span>
          </div>
        </div>

        <div class="monitoring-banner state-unavailable">
          <span class="state-dot"></span>
          <b>NO ASSESSMENT COMPUTED YET</b>
          <div class="state-sub">
            The system has not recorded enough speech or chat to evaluate risk. 
            <b>This does NOT mean the call is safe.</b>
          </div>
        </div>

        <div class="actions-toolbar mt-4">
          <button class="btn btn-danger" id="btnEndCall" ${canEndCall ? '' : 'disabled'}>
            <span class="btn-icon">⏹</span> End Meet Call Now
          </button>
          <button class="btn btn-secondary" id="btnChakshuReport">
            <span class="btn-icon">🛡</span> Report to Chakshu
          </button>
          <button class="btn btn-outline" id="btnIncidentReport">
            <span class="btn-icon">📄</span> Incident Report
          </button>
        </div>
      </div>
    `;

    this._bindEvents(null, null);
  }

  _bindEvents(activeSessionId, token) {
    const endCallBtn = document.getElementById('btnEndCall');
    if (endCallBtn) {
      endCallBtn.onclick = () => {
        if (this.onEndCall) this.onEndCall();
      };
    }

    const chakshuBtn = document.getElementById('btnChakshuReport');
    if (chakshuBtn) {
      chakshuBtn.onclick = () => {
        if (this.onOpenChakshu) this.onOpenChakshu();
      };
    }

    const reportBtn = document.getElementById('btnIncidentReport');
    if (reportBtn) {
      reportBtn.onclick = () => {
        if (this.onOpenReport) this.onOpenReport();
      };
    }
  }
}

