// CallShield REST API Client

class ApiClient {
  constructor() {
    const params = new URLSearchParams(window.location.search);
    this.token = params.get('token') || localStorage.getItem('cs_token') || 'dev-token';
    try {
      localStorage.setItem('cs_token', this.token);
    } catch {}
  }

  setToken(newToken) {
    this.token = newToken.trim();
    try {
      localStorage.setItem('cs_token', this.token);
    } catch {}
  }

  getToken() {
    return this.token;
  }

  async request(path, opts = {}) {
    const url = path;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
      ...(opts.headers || {}),
    };

    try {
      const res = await fetch(url, { ...opts, headers });
      if (!res.ok) {
        let errText = '';
        try {
          const jsonErr = await res.json();
          errText = jsonErr.detail || JSON.stringify(jsonErr);
        } catch {
          errText = await res.text();
        }
        throw new Error(`${res.status} ${errText || res.statusText}`);
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        return await res.json();
      }
      return await res.text();
    } catch (err) {
      console.warn(`[API] Error on ${opts.method || 'GET'} ${path}:`, err.message);
      throw err;
    }
  }

  // System
  async getHealth() {
    // Health is public and does not strictly require auth
    const res = await fetch('/health');
    if (!res.ok) throw new Error(`Health error: ${res.status}`);
    return await res.json();
  }

  // Sessions
  async listSessions() {
    return await this.request('/api/sessions');
  }

  async getSession(sessionId) {
    return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  async getReport(sessionId, format = 'json') {
    return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/report?format=${format}`);
  }

  async endCall(sessionId) {
    return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/end_call`, {
      method: 'POST',
    });
  }

  async injectText(sessionId, text, speakerRole = 'remote') {
    return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject_text`, {
      method: 'POST',
      body: JSON.stringify({ text, speaker_role: speakerRole }),
    });
  }

  // Vision
  async getVisionLatest(sessionId) {
    return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/vision/latest`);
  }

  // Mock Bank
  async listTransfers(sessionId = null) {
    const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
    return await this.request(`/api/bank/transfers${q}`);
  }

  async createTransfer(sessionId, amount, payee) {
    return await this.request('/api/bank/transfers', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, amount: Number(amount), payee }),
    });
  }

  async releaseTransfer(transferId) {
    return await this.request(`/api/bank/transfers/${encodeURIComponent(transferId)}/release`, {
      method: 'POST',
    });
  }

  async verifyAttestation(attestation) {
    return await this.request('/api/bank/verify', {
      method: 'POST',
      body: JSON.stringify(attestation),
    });
  }
}

export const api = new ApiClient();

