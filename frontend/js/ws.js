// CallShield Dashboard WebSocket Client

export class DashboardWs {
  constructor(apiClient, onMessage, onStatusChange) {
    this.api = apiClient;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
    this.ws = null;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 10000;
    this.reconnectTimer = null;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = window.location.host;
    const token = this.api.getToken();
    const url = `${proto}://${host}/ws/dashboard?token=${encodeURIComponent(token)}`;

    this.onStatusChange('connecting', 'Connecting to backend stream…');

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.error('[WS] Initialization failed:', e);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.onStatusChange('connected', 'Live telemetry active');
    };

    this.ws.onclose = (event) => {
      this.ws = null;
      if (event.code === 4401) {
        this.onStatusChange('auth_error', 'Authentication failed (invalid token)');
        // Don't rapid-retry on auth failure
        return;
      }
      this.onStatusChange('disconnected', 'Disconnected from backend stream');
      if (this.shouldReconnect) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.warn('[WS] Socket error:', err);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.onMessage(data);
      } catch (e) {
        console.error('[WS] Failed to parse message JSON:', e, event.data);
      }
    };
  }

  _scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts - 1), this.maxReconnectDelay);
    this.onStatusChange('reconnecting', `Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})…`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.onStatusChange('disconnected', 'Disconnected');
  }

  reconnectWithNewToken() {
    this.disconnect();
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.connect();
  }
}

