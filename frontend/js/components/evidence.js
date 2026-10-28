// CallShield Fraud Evidence Ledger Component
// Displays grounded evidence, modalities, technical quality, rule references, and model retractions.

import { esc, fmtTime, CATEGORY_DESCRIPTIONS } from '../formatters.js';

export class EvidenceComponent {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
  }

  render(events = [], retractions = new Map()) {
    const evidenceEvents = events.filter(e => e.event_type === 'evidence');
    // Display recent first
    const reversed = [...evidenceEvents].reverse();

    this.container.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-wrap">
          <h3 class="panel-title">Fraud Evidence Ledger</h3>
          <span class="badge badge-subtle">${evidenceEvents.length} Recorded Findings</span>
        </div>
      </div>

      <div class="evidence-feed">
        ${reversed.length === 0 ? `
          <div class="empty-feed">
            <span class="empty-icon">🛡</span>
            <p>No fraud evidence triggered yet.</p>
          </div>
        ` : ''}
        ${reversed.map(e => {
          const p = e.payload;
          const isRetracted = retractions.has(p.evidence_id);
          const retractReason = retractions.get(p.evidence_id);

          return `
            <div class="evidence-card ${isRetracted ? 'card-retracted' : ''}">
              <div class="ev-card-top">
                <div class="ev-card-badges">
                  <span class="badge ${isRetracted ? 'badge-muted' : 'badge-danger'}">
                    ${esc(p.category)}
                  </span>
                  <span class="tag tag-${esc(p.source_modality)}">
                    ${esc(p.source_modality.toUpperCase())}
                  </span>
                  ${p.is_mock ? '<span class="badge badge-warn">MOCK / SIMULATED</span>' : ''}
                  ${p.rule_refs && p.rule_refs.length > 0 ? `
                    <span class="rule-refs">${esc(p.rule_refs.join(', '))}</span>
                  ` : ''}
                </div>
                <div class="ev-card-time">
                  ${fmtTime(p.t_end_ms)}
                </div>
              </div>

              ${isRetracted ? `
                <div class="retraction-notice">
                  <span class="retract-icon">↩</span>
                  <b>EVIDENCE WITHDRAWN BY MODEL:</b> ${esc(retractReason)}
                </div>
              ` : ''}

              <div class="ev-quote-box">
                <div class="quote-text">“${esc(p.quoted_text_or_observation)}”</div>
                <div class="category-explanation">
                  ${esc(CATEGORY_DESCRIPTIONS[p.category] || 'Specific fraud pattern detected.')}
                </div>
              </div>

              <div class="ev-card-footer">
                <span class="ev-id">ID: <code>${esc(p.evidence_id)}</code></span>
                ${p.quality != null ? `
                  <span class="quality-badge" title="Technical detection quality score (0.0 to 1.0) multiplied into fusion weight. Not a calibrated real-world probability.">
                    Technical Quality: <b>${p.quality}</b>
                  </span>
                ` : ''}
                <span class="source-refs">Source IDs: ${(p.source_event_ids || []).map(r => `<code>${esc(r)}</code>`).join(' ')}</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }
}

