// CallShield Simulated Banking Protection Component
// Emphasizes explicit SIMULATION nature, HMAC risk attestation verification, and release workflow.

import { esc, fmtTime, fmtDateTime, fmtCurrencyINR } from '../formatters.js';

export class BankComponent {
  constructor(containerId, api, onRefresh) {
    this.container = document.getElementById(containerId);
    this.api = api;
    this.onRefresh = onRefresh;
    this.attestationModal = document.getElementById('attestationModal');
  }

  render(transfers = [], sessionId = null, isFrozen = false) {
    this.container.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-wrap">
          <h3 class="panel-title">Simulated Banking Protection</h3>
          <span class="badge badge-simulated">SIMULATION ONLY</span>
          ${isFrozen ? '<span class="badge badge-danger">POLICY FREEZE ACTIVE</span>' : '<span class="badge badge-ok">NORMAL (NO HOLD)</span>'}
        </div>
        <div class="panel-desc">
          Simulates real-time risk-policy holds on banking transactions during an active high-risk call. 
          <b>No real banks or financial accounts are accessed.</b>
        </div>
      </div>

      <form id="simTransferForm" class="transfer-form">
        <div class="form-inputs">
          <div class="form-group flex-1">
            <label class="form-label" for="transferAmount">Transfer Amount (INR)</label>
            <div class="input-with-currency">
              <span class="curr-prefix">₹</span>
              <input type="number" id="transferAmount" class="input-text" min="1" max="10000000" value="200000" required />
            </div>
            <div class="quick-chips">
              <button type="button" class="chip-btn" data-amt="50000">₹50K</button>
              <button type="button" class="chip-btn" data-amt="200000">₹2 Lakh</button>
              <button type="button" class="chip-btn" data-amt="500000">₹5 Lakh</button>
            </div>
          </div>

          <div class="form-group flex-2">
            <label class="form-label" for="transferPayee">Payee UPI ID / Account</label>
            <input type="text" id="transferPayee" class="input-text" value="verify.cbi@upi" required />
            <div class="quick-chips">
              <button type="button" class="chip-btn" data-payee="verify.cbi@upi">CBI Verification</button>
              <button type="button" class="chip-btn" data-payee="rbi.safety.vault@upi">RBI Safe Account</button>
              <button type="button" class="chip-btn" data-payee="mumbai.police.cyber@bank">Police Cyber Cell</button>
            </div>
          </div>

          <div class="form-group flex-action">
            <button type="submit" class="btn btn-primary" id="btnSimulateTx">
              Simulate Transfer
            </button>
          </div>
        </div>
      </form>

      <div class="tx-table-container">
        <table class="tx-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Transfer ID</th>
              <th>Amount</th>
              <th>Payee</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Attestation</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${transfers.length === 0 ? `
              <tr>
                <td colspan="8" class="text-center muted py-4">No simulated transfers recorded for this session.</td>
              </tr>
            ` : ''}
            ${transfers.map(t => {
              const statusClass = {
                HOLD: 'status-danger',
                DECLINED: 'status-danger',
                ALLOWED: 'status-ok',
                RELEASED: 'status-ok',
                PENDING: 'status-warn',
              }[t.status] || 'status-muted';

              const hasAttestation = t.attestation && t.attestation.signature;

              return `
                <tr class="tx-row tx-${t.status}">
                  <td class="tx-time">${fmtTime(t.created_ms)}</td>
                  <td><code>${esc(t.transfer_id)}</code></td>
                  <td class="tx-amount">${fmtCurrencyINR(t.amount)}</td>
                  <td class="tx-payee">${esc(t.payee)}</td>
                  <td><span class="status-pill ${statusClass}">${esc(t.status)}</span></td>
                  <td class="tx-reason" title="${esc(t.reason)}">${esc(t.reason)}</td>
                  <td>
                    ${hasAttestation ? `
                      <button class="btn btn-xs btn-outline btn-inspect-att" data-id="${esc(t.transfer_id)}">
                        Inspect Signature
                      </button>
                    ` : '<span class="text-muted small">None</span>'}
                  </td>
                  <td>
                    ${t.status === 'HOLD' ? `
                      <button class="btn btn-xs btn-secondary btn-release-tx" data-id="${esc(t.transfer_id)}">
                        Release Hold
                      </button>
                    ` : '<span class="text-muted small">–</span>'}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    this._bindEvents(transfers, sessionId);
  }

  _bindEvents(transfers, sessionId) {
    const form = document.getElementById('simTransferForm');
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (!sessionId) {
          alert('Please select or start a session first.');
          return;
        }
        const amtInput = document.getElementById('transferAmount');
        const payeeInput = document.getElementById('transferPayee');
        const submitBtn = document.getElementById('btnSimulateTx');

        submitBtn.disabled = true;
        try {
          await this.api.createTransfer(sessionId, amtInput.value, payeeInput.value);
          if (this.onRefresh) await this.onRefresh();
        } catch (err) {
          alert(`Failed to simulate transfer: ${err.message}`);
        } finally {
          submitBtn.disabled = false;
        }
      };
    }

    // Amount chips
    const amtChips = this.container.querySelectorAll('[data-amt]');
    amtChips.forEach(chip => {
      chip.onclick = () => {
        const amtInput = document.getElementById('transferAmount');
        if (amtInput) amtInput.value = chip.dataset.amt;
      };
    });

    // Payee chips
    const payeeChips = this.container.querySelectorAll('[data-payee]');
    payeeChips.forEach(chip => {
      chip.onclick = () => {
        const payeeInput = document.getElementById('transferPayee');
        if (payeeInput) payeeInput.value = chip.dataset.payee;
      };
    });

    // Release buttons
    const releaseBtns = this.container.querySelectorAll('.btn-release-tx');
    releaseBtns.forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        if (!confirm(`Release simulated transaction ${id}?`)) return;
        btn.disabled = true;
        try {
          await this.api.releaseTransfer(id);
          if (this.onRefresh) await this.onRefresh();
        } catch (err) {
          alert(`Release failed: ${err.message}`);
          btn.disabled = false;
        }
      };
    });

    // Inspect attestation buttons
    const inspectBtns = this.container.querySelectorAll('.btn-inspect-att');
    inspectBtns.forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        const tx = transfers.find(t => t.transfer_id === id);
        if (tx && tx.attestation) {
          this.showAttestationModal(tx);
        }
      };
    });
  }

  showAttestationModal(tx) {
    if (!this.attestationModal) return;
    const att = tx.attestation;
    const claims = att.claims || {};

    this.attestationModal.innerHTML = `
      <div class="modal-backdrop" id="attBackdrop"></div>
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="attTitle">
        <div class="modal-header">
          <div>
            <div class="modal-pretitle">Cryptographic Attestation</div>
            <h3 id="attTitle" class="modal-title">HMAC-SHA256 Risk Attestation</h3>
          </div>
          <button class="icon-button" id="attCloseBtn" title="Close" aria-label="Close">✕</button>
        </div>

        <div class="modal-body">
          <div class="alert-box info-box">
            <div class="alert-icon">🔒</div>
            <div>
              When CallShield's policy engine freezes transfers at High/Critical risk, it signs an HMAC attestation for the banking institution.
            </div>
          </div>

          <div class="claims-list">
            <div class="claims-row"><span class="k">Algorithm:</span> <span class="v"><code>${esc(att.alg || 'HS256')}</code></span></div>
            <div class="claims-row"><span class="k">Session ID:</span> <span class="v"><code>${esc(claims.session_id)}</code></span></div>
            <div class="claims-row"><span class="k">Triggering Assessment:</span> <span class="v"><code>${esc(claims.assessment_id)}</code></span></div>
            <div class="claims-row"><span class="k">Risk Level Claimed:</span> <span class="v"><b>${esc(claims.risk_level)}</b> (Index: ${claims.risk_index}/100)</span></div>
            <div class="claims-row"><span class="k">Timestamp:</span> <span class="v">${fmtDateTime(claims.issued_ms)}</span></div>
            <div class="claims-row"><span class="k">Signature:</span> <span class="v"><code class="break-all">${esc(att.signature)}</code></span></div>
          </div>

          <div id="verifyResult" class="verify-status mt-4"></div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-outline" id="btnVerifySignature">Verify with Backend Secret</button>
          <button class="btn btn-primary" id="attDoneBtn">Close</button>
        </div>
      </div>
    `;

    this.attestationModal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    const close = () => {
      this.attestationModal.classList.add('hidden');
      document.body.classList.remove('modal-open');
    };

    document.getElementById('attBackdrop').onclick = close;
    document.getElementById('attCloseBtn').onclick = close;
    document.getElementById('attDoneBtn').onclick = close;

    const verifyBtn = document.getElementById('btnVerifySignature');
    verifyBtn.onclick = async () => {
      verifyBtn.disabled = true;
      const statusDiv = document.getElementById('verifyResult');
      statusDiv.innerHTML = '<span class="text-muted">Verifying signature with server secret…</span>';
      try {
        const res = await this.api.verifyAttestation(att);
        if (res.valid) {
          statusDiv.innerHTML = '<div class="alert-box success-box"><div class="alert-icon">✓</div><div><b>Signature VALID:</b> HMAC-SHA256 signature verified against CALLSHIELD_ATTEST_SECRET.</div></div>';
        } else {
          statusDiv.innerHTML = '<div class="alert-box warn-box"><div class="alert-icon">✕</div><div><b>Signature INVALID:</b> Tampered or mismatched signature.</div></div>';
        }
      } catch (err) {
        statusDiv.innerHTML = `<div class="alert-box danger-box"><div class="alert-icon">✕</div><div>Verification failed: ${esc(err.message)}</div></div>`;
      } finally {
        verifyBtn.disabled = false;
      }
    };
  }
}

