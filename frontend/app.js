// CallShield Dashboard Application Orchestrator

import { api } from './js/api.js';
import { state } from './js/state.js';
import { DashboardWs } from './js/ws.js';
import { esc } from './js/formatters.js';

import { RiskComponent } from './js/components/risk.js';
import { BankComponent } from './js/components/bank.js';
import { TranscriptComponent } from './js/components/transcript.js';
import { EvidenceComponent } from './js/components/evidence.js';
import { TelemetryStripComponent } from './js/components/strip.js';
import { DiagnosticsComponent } from './js/components/health_detail.js';
import { VisionComponent } from './js/components/vision.js';
import { ChakshuWorkflow } from './js/components/chakshu.js';
import { ReportModal } from './js/components/report.js';

class CallShieldApp {
  constructor() {
    this.ws = null;
    this.transferPollInterval = null;

    // Component instances
    this.chakshu = new ChakshuWorkflow('chakshuModal');
    this.reportModal = new ReportModal('reportModal', () => this.openChakshuForActive());

    this.riskComp = new RiskComponent(
      'riskContainer',
      () => this.promptEndCall(),
      () => this.openChakshuForActive(),
      () => this.openReportForActive()
    );

    this.bankComp = new BankComponent(
      'bankContainer',
      api,
      () => this.refreshTransfers()
    );

    this.transcriptComp = new TranscriptComponent(
      'transcriptContainer',
      (sid, text, role) => api.injectText(sid, text, role)
    );

    this.evidenceComp = new EvidenceComponent('evidenceContainer');
    this.visionComp = new VisionComponent('visionContainer', api);
    this.stripComp = new TelemetryStripComponent('telemetryStripContainer');
    this.diagComp = new DiagnosticsComponent('diagnosticsContainer');

    this.init();
  }

  async init() {
    this._bindGlobalDom();

    // Check system health
    try {
      const health = await api.getHealth();
      state.setSystemHealth(health);
      this.renderSystemHealth(health);
    } catch (err) {
      console.warn('System health check error:', err);
      this.renderSystemHealth(null);
    }

    // Connect WebSocket
    this.ws = new DashboardWs(
      api,
      (msg) => this.handleWsMessage(msg),
      (status, text) => this.handleWsStatus(status, text)
    );
    this.ws.connect();

    // Initial session fetch
    await this.loadSessions();

    // Handle URL parameters
    const params = new URLSearchParams(window.location.search);
    const targetSession = params.get('session');
    if (targetSession) {
      await this.selectSession(targetSession);
    } else if (state.sessions.size > 0 && !state.selectedSessionId) {
      const firstId = state.sessions.keys().next().value;
      await this.selectSession(firstId);
    }

    // Subscribe to state notifications
    state.subscribe((event, payload) => this.onStateChange(event, payload));

    // Periodic settlement refresh for active session bank transfers
    this.transferPollInterval = setInterval(() => {
      if (state.selectedSessionId) {
        this.refreshTransfers().catch(() => {});
      }
    }, 3000);
  }

  _bindGlobalDom() {
    // Refresh Sessions Button
    const refreshBtn = document.getElementById('btnRefreshSessions');
    if (refreshBtn) {
      refreshBtn.onclick = () => this.loadSessions();
    }

    // Token Config Modal
    const tokenBtn = document.getElementById('btnConfigToken');
    const tokenModal = document.getElementById('tokenModal');
    const tokenInput = document.getElementById('tokenInput');
    const tokenBackdrop = document.getElementById('tokenBackdrop');
    const tokenCloseBtn = document.getElementById('tokenCloseBtn');
    const tokenCancelBtn = document.getElementById('tokenCancelBtn');
    const tokenSaveBtn = document.getElementById('tokenSaveBtn');

    if (tokenBtn && tokenModal) {
      tokenBtn.onclick = () => {
        tokenInput.value = api.getToken();
        tokenModal.classList.remove('hidden');
      };
    }

    const closeTokenModal = () => tokenModal.classList.add('hidden');
    if (tokenBackdrop) tokenBackdrop.onclick = closeTokenModal;
    if (tokenCloseBtn) tokenCloseBtn.onclick = closeTokenModal;
    if (tokenCancelBtn) tokenCancelBtn.onclick = closeTokenModal;

    if (tokenSaveBtn) {
      tokenSaveBtn.onclick = () => {
        const val = tokenInput.value.trim();
        if (val) {
          api.setToken(val);
          closeTokenModal();
          this.ws.reconnectWithNewToken();
          this.loadSessions();
        }
      };
    }

    // End Call Safety Confirmation Modal
    const endCallModal = document.getElementById('endCallConfirmModal');
    const endCallBackdrop = document.getElementById('endCallBackdrop');
    const endCallCloseBtn = document.getElementById('endCallCloseBtn');
    const endCallCancelBtn = document.getElementById('endCallCancelBtn');
    const endCallExecuteBtn = document.getElementById('endCallExecuteBtn');

    const closeEndCallModal = () => endCallModal.classList.add('hidden');
    if (endCallBackdrop) endCallBackdrop.onclick = closeEndCallModal;
    if (endCallCloseBtn) endCallCloseBtn.onclick = closeEndCallModal;
    if (endCallCancelBtn) endCallCancelBtn.onclick = closeEndCallModal;

    if (endCallExecuteBtn) {
      endCallExecuteBtn.onclick = async () => {
        closeEndCallModal();
        if (!state.selectedSessionId) return;
        try {
          await api.endCall(state.selectedSessionId);
        } catch (err) {
          alert(`End call command failed: ${err.message}`);
        }
      };
    }
  }

  promptEndCall() {
    const endCallModal = document.getElementById('endCallConfirmModal');
    if (endCallModal) {
      endCallModal.classList.remove('hidden');
    }
  }

  async loadSessions() {
    try {
      const list = await api.listSessions();
      state.setSessionsList(list);
      this.renderSidebarSessions();
    } catch (err) {
      console.warn('Failed to list sessions:', err);
    }
  }

  async selectSession(sessionId) {
    if (!sessionId) return;
    try {
      const detail = await api.getSession(sessionId);
      state.selectSession(sessionId, detail);

      // Update URL query without full reload
      const url = new URL(window.location);
      url.searchParams.set('session', sessionId);
      window.history.replaceState({}, '', url);

      this.renderSidebarSessions();
      this.renderActiveWorkspace();
    } catch (err) {
      console.error(`Failed to select session ${sessionId}:`, err);
    }
  }

  renderSidebarSessions() {
    const ul = document.getElementById('sessionsList');
    if (!ul) return;
    ul.innerHTML = '';

    for (const [id, s] of state.sessions) {
      const li = document.createElement('li');
      const isSelected = id === state.selectedSessionId;
      li.className = `session-item ${isSelected ? 'active' : ''}`;

      const isLive = s.health && s.health.active;
      const isExtConnected = s.health && s.health.extension_connected;
      const statusLabel = isLive ? (isExtConnected ? 'LIVE' : 'DISCONNECTED') : 'ENDED';
      const statusClass = isLive ? (isExtConnected ? 'badge-ok' : 'badge-warn') : 'badge-muted';

      const riskLevel = s.level || '–';
      const riskClass = {
        normal: 'risk-text-normal',
        caution: 'risk-text-caution',
        high: 'risk-text-high',
        critical: 'risk-text-critical',
      }[s.level] || 'text-muted';

      li.innerHTML = `
        <div class="session-top">
          <span class="session-id" title="${esc(id)}">${esc(id)}</span>
          <span class="session-badge ${statusClass}">${statusLabel}</span>
        </div>
        <div class="session-sub">
          <span class="${riskClass}"><b>${esc(riskLevel.toUpperCase())}</b> ${s.index != null ? `(${s.index})` : ''}</span>
          <span>${s.health && s.health.counters ? `${s.health.counters.audio_chunks_meet_tab || 0} audio` : ''}</span>
        </div>
      `;

      li.onclick = () => this.selectSession(id);
      ul.appendChild(li);
    }
  }

  renderSystemHealth(h) {
    const el = document.getElementById('systemHealthBadge');
    if (!el) return;
    if (!h) {
      el.textContent = 'Backend: Unreachable';
      el.className = 'text-danger small';
      return;
    }
    const mode = h.pipeline?.is_mock ? 'Mock Detector' : 'Live Sarvam/LLM';
    el.innerHTML = `Engine: <b>${esc(mode)}</b> · v${esc(h.risk_config_version || '1')}`;
  }

  renderActiveWorkspace() {
    const emptyState = document.getElementById('emptyState');
    const activeView = document.getElementById('activeSessionView');

    if (!state.selectedSessionId) {
      if (emptyState) emptyState.classList.remove('hidden');
      if (activeView) activeView.classList.add('hidden');
      this.visionComp.setSession(null);
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');
    if (activeView) activeView.classList.remove('hidden');

    const active = state.activeSession;
    const latestAsm = state.getLatestAssessment();
    const isFrozen = Boolean(active.health && active.health.bank_frozen);

    this.stripComp.render(active.health);
    this.riskComp.render(latestAsm, active.health, state.selectedSessionId, api.getToken());
    this.visionComp.setSession(state.selectedSessionId);
    this.bankComp.render(active.transfers, state.selectedSessionId, isFrozen);
    this.transcriptComp.render(active.events, active.flaggedEvents, state.selectedSessionId);
    this.evidenceComp.render(active.events, active.retractions);
    this.diagComp.render(active.health, active.events);
  }

  async refreshTransfers() {
    if (!state.selectedSessionId) return;
    try {
      const transfers = await api.listTransfers(state.selectedSessionId);
      state.setTransfers(transfers);
      const isFrozen = Boolean(state.activeSession.health && state.activeSession.health.bank_frozen);
      this.bankComp.render(transfers, state.selectedSessionId, isFrozen);
    } catch {}
  }

  async openChakshuForActive() {
    if (!state.selectedSessionId) return;
    const session = state.sessions.get(state.selectedSessionId) || {};
    const payload = {
      sessionId: state.selectedSessionId,
      createdMs: session.created_ms || Date.now(),
      events: state.activeSession.events,
      retractions: state.activeSession.retractions,
      peakAssessment: state.getPeakAssessment(),
    };
    this.chakshu.open(payload);
  }

  async openReportForActive() {
    if (!state.selectedSessionId) return;
    try {
      const [jsonReport, mdReport] = await Promise.all([
        api.getReport(state.selectedSessionId, 'json'),
        api.getReport(state.selectedSessionId, 'md'),
      ]);
      this.reportModal.open(jsonReport, mdReport, state.selectedSessionId);
    } catch (err) {
      alert(`Could not load report: ${err.message}`);
    }
  }

  handleWsStatus(status, text) {
    const pill = document.getElementById('connectionPill');
    const label = document.getElementById('connectionText');
    if (pill) {
      pill.className = `connection-pill ${status}`;
    }
    if (label) {
      label.textContent = text;
    }
    state.setWsStatus(status, text);
  }

  handleWsMessage(msg) {
    if (msg.kind === 'hello') {
      // Received snapshot of running sessions
      if (Array.isArray(msg.sessions)) {
        for (const h of msg.sessions) {
          if (h && h.session_id) {
            state.updateSessionHealth(h.session_id, h);
          }
        }
      }
      this.loadSessions();
    } else if (msg.kind === 'health') {
      state.updateSessionHealth(msg.session_id, msg.health);
      if (msg.session_id === state.selectedSessionId) {
        this.stripComp.render(msg.health);
        const latestAsm = state.getLatestAssessment();
        this.riskComp.render(latestAsm, msg.health, state.selectedSessionId, api.getToken());
        this.diagComp.render(msg.health, state.activeSession.events);
      }
      this.renderSidebarSessions();
    } else if (msg.kind === 'event') {
      const ev = msg.event;
      state.addEvent(ev, true);

      if (ev.session_id === state.selectedSessionId) {
        const active = state.activeSession;
        if (ev.event_type === 'assessment') {
          this.riskComp.render(ev, active.health, state.selectedSessionId, api.getToken());
          this.diagComp.render(active.health, active.events);
        } else if (ev.event_type === 'utterance' || ev.event_type === 'chat_message') {
          this.transcriptComp.render(active.events, active.flaggedEvents, state.selectedSessionId);
        } else if (ev.event_type === 'evidence' || ev.event_type === 'retraction') {
          this.evidenceComp.render(active.events, active.retractions);
          this.transcriptComp.render(active.events, active.flaggedEvents, state.selectedSessionId);
          const latestAsm = state.getLatestAssessment();
          this.riskComp.render(latestAsm, active.health, state.selectedSessionId, api.getToken());
          if (ev.payload?.source_modality === 'video') {
            this.visionComp.refresh();
          }
        } else if (ev.event_type === 'action') {
          this.diagComp.render(active.health, active.events);
          if (ev.payload.action_type === 'bank_hold') {
            this.refreshTransfers();
          }
        }
      }
      this.renderSidebarSessions();
    }
  }

  onStateChange(event, payload) {
    if (event === 'sessions_updated') {
      this.renderSidebarSessions();
    }
  }
}

// Start application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.callshield = new CallShieldApp();
});
