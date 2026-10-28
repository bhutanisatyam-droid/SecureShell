// CallShield Central State Store

export class StateStore {
  constructor() {
    this.sessions = new Map(); // id -> { session_id, live, health, level, index, created_ms, ended_ms }
    this.selectedSessionId = null;
    this.activeSession = {
      events: [],
      health: null,
      transfers: [],
      retractions: new Map(), // evidence_id -> reason
      flaggedEvents: new Map(), // source_event_id -> Set of categories
    };
    this.systemHealth = null;
    this.wsStatus = { state: 'disconnected', message: 'Not connected' };
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(eventType, payload) {
    for (const listener of this.listeners) {
      try {
        listener(eventType, payload, this);
      } catch (err) {
        console.error('[State] Listener error:', err);
      }
    }
  }

  setWsStatus(state, message) {
    this.wsStatus = { state, message };
    this.notify('ws_status', this.wsStatus);
  }

  setSystemHealth(health) {
    this.systemHealth = health;
    this.notify('system_health', health);
  }

  setSessionsList(list) {
    for (const row of list) {
      const cur = this.sessions.get(row.session_id) || {};
      this.sessions.set(row.session_id, {
        ...cur,
        ...row,
        health: row.live || cur.health || { active: !row.ended_ms },
      });
    }
    this.notify('sessions_updated', this.sessions);
  }

  updateSessionHealth(sessionId, health) {
    const s = this.sessions.get(sessionId) || { session_id: sessionId };
    s.health = health;
    if (health) {
      s.active = health.active;
      s.monitoring_state = health.monitoring_state;
      s.inference_mode = health.inference_mode;
    }
    this.sessions.set(sessionId, s);

    if (sessionId === this.selectedSessionId) {
      this.activeSession.health = health;
      this.notify('active_health_updated', health);
    }
    this.notify('sessions_updated', this.sessions);
  }

  selectSession(sessionId, detailData) {
    this.selectedSessionId = sessionId;
    this.activeSession = {
      events: [],
      health: detailData.health,
      transfers: detailData.transfers || [],
      retractions: new Map(),
      flaggedEvents: new Map(),
    };

    if (detailData.events) {
      for (const ev of detailData.events) {
        this._processEventIntoActive(ev);
      }
    }

    // Update session map entry
    const s = this.sessions.get(sessionId) || { session_id: sessionId };
    if (detailData.health) {
      s.health = detailData.health;
    }
    const latestAsm = this.getLatestAssessment();
    if (latestAsm) {
      s.level = latestAsm.payload.risk_level;
      s.index = latestAsm.payload.risk_index;
    }
    this.sessions.set(sessionId, s);

    this.notify('session_selected', { sessionId, activeSession: this.activeSession });
  }

  addEvent(event, live = true) {
    const sid = event.session_id;

    // Track session presence
    if (!this.sessions.has(sid)) {
      this.sessions.set(sid, { session_id: sid, health: { active: true } });
      this.notify('sessions_updated', this.sessions);
    }

    if (event.event_type === 'assessment') {
      const s = this.sessions.get(sid);
      if (s) {
        s.level = event.payload.risk_level;
        s.index = event.payload.risk_index;
        this.notify('sessions_updated', this.sessions);
      }
    }

    if (sid === this.selectedSessionId) {
      this._processEventIntoActive(event);
      if (live) {
        this.notify('event_added', event);
      }
    }
  }

  _processEventIntoActive(event) {
    this.activeSession.events.push(event);

    if (event.event_type === 'retraction') {
      const payload = event.payload;
      for (const id of payload.evidence_ids || []) {
        this.activeSession.retractions.set(id, payload.reason);
      }
    } else if (event.event_type === 'evidence') {
      const payload = event.payload;
      for (const ref of payload.source_event_ids || []) {
        if (!this.activeSession.flaggedEvents.has(ref)) {
          this.activeSession.flaggedEvents.set(ref, new Set());
        }
        this.activeSession.flaggedEvents.get(ref).add(payload.category);
      }
    }
  }

  setTransfers(transfers) {
    this.activeSession.transfers = transfers || [];
    this.notify('transfers_updated', this.activeSession.transfers);
  }

  getLatestAssessment() {
    const events = this.activeSession.events;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].event_type === 'assessment') {
        return events[i];
      }
    }
    return null;
  }

  getPeakAssessment() {
    const events = this.activeSession.events;
    let peak = null;
    const order = { normal: 0, caution: 1, high: 2, critical: 3 };
    for (const e of events) {
      if (e.event_type === 'assessment') {
        const p = e.payload;
        if (!peak) {
          peak = p;
        } else {
          const curRank = order[p.risk_level] ?? 0;
          const peakRank = order[peak.risk_level] ?? 0;
          if (curRank > peakRank || (curRank === peakRank && p.risk_index > peak.risk_index)) {
            peak = p;
          }
        }
      }
    }
    return peak;
  }

  getRetractedMap() {
    return this.activeSession.retractions;
  }

  getFlaggedCategoriesFor(eventId) {
    const set = this.activeSession.flaggedEvents.get(eventId);
    return set ? Array.from(set) : [];
  }
}

export const state = new StateStore();

