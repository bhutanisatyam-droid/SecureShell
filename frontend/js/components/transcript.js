// CallShield Live Transcript & Chat Component
// Handles Hinglish / Devanagari Unicode, speaker roles, flagged threats, and test injection.

import { esc, fmtTime } from '../formatters.js';

export class TranscriptComponent {
  constructor(containerId, onInjectText) {
    this.container = document.getElementById(containerId);
    this.onInjectText = onInjectText;
    this.filter = 'all'; // 'all' | 'speech' | 'chat' | 'flagged'
    this.autoScroll = true;
  }

  render(events = [], flaggedMap = new Map(), sessionId = null) {
    const rawItems = events.filter(e => e.event_type === 'utterance' || e.event_type === 'chat_message');

    let filtered = rawItems;
    if (this.filter === 'speech') {
      filtered = rawItems.filter(e => e.event_type === 'utterance');
    } else if (this.filter === 'chat') {
      filtered = rawItems.filter(e => e.event_type === 'chat_message');
    } else if (this.filter === 'flagged') {
      filtered = rawItems.filter(e => {
        const cats = flaggedMap.get(e.event_id);
        return cats && cats.size > 0;
      });
    }

    this.container.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-wrap">
          <h3 class="panel-title">Live Transcript &amp; Meet Chat</h3>
          <span class="badge badge-subtle">Hinglish / Devanagari UTF-8</span>
        </div>
        <div class="transcript-controls">
          <div class="filter-tabs">
            <button class="filter-btn ${this.filter === 'all' ? 'active' : ''}" data-filter="all">All (${rawItems.length})</button>
            <button class="filter-btn ${this.filter === 'speech' ? 'active' : ''}" data-filter="speech">Speech</button>
            <button class="filter-btn ${this.filter === 'chat' ? 'active' : ''}" data-filter="chat">Chat</button>
            <button class="filter-btn ${this.filter === 'flagged' ? 'active' : ''}" data-filter="flagged">Flagged Only</button>
          </div>
          <label class="autoscroll-toggle">
            <input type="checkbox" id="autoScrollCheck" ${this.autoScroll ? 'checked' : ''} />
            <span>Auto-scroll</span>
          </label>
        </div>
      </div>

      <div class="transcript-feed" id="transcriptFeed">
        ${filtered.length === 0 ? `
          <div class="empty-feed">
            <span class="empty-icon">💬</span>
            <p>No utterances or chat messages matching filter.</p>
          </div>
        ` : ''}
        ${filtered.map(e => {
          const isChat = e.event_type === 'chat_message';
          const p = e.payload;
          const role = isChat ? (p.sender_role || 'unknown') : (p.speaker_role || 'unknown');
          const catsSet = flaggedMap.get(e.event_id);
          const cats = catsSet ? Array.from(catsSet) : [];
          const isFlagged = cats.length > 0;

          const roleClass = {
            remote: 'role-remote',
            local: 'role-local',
            unknown: 'role-unknown',
          }[role] || 'role-unknown';

          return `
            <div class="feed-item ${isFlagged ? 'item-flagged' : ''} ${isChat ? 'item-chat' : 'item-speech'}" data-id="${esc(e.event_id)}">
              <div class="feed-item-header">
                <span class="timestamp">${fmtTime(e.timestamp_ms)}</span>
                <span class="modality-tag ${isChat ? 'tag-chat' : 'tag-speech'}">
                  ${isChat ? 'CHAT' : 'SPEECH'}
                </span>
                <span class="role-pill ${roleClass}">
                  ${role === 'local' ? 'YOU (LOCAL)' : role === 'remote' ? 'CALLER (REMOTE)' : 'UNKNOWN'}
                </span>
                ${p.is_mock ? '<span class="badge badge-injected">TEST INJECTED</span>' : ''}
                ${isChat && p.sender_label ? `<span class="sender-name">${esc(p.sender_label)}</span>` : ''}
                <div class="flag-tags">
                  ${cats.map(c => `<span class="flag-pill">⚠ ${esc(c)}</span>`).join('')}
                </div>
              </div>

              <div class="feed-item-body">
                <span class="feed-text">${esc(p.text)}</span>
                ${isChat && p.links && p.links.length > 0 ? `
                  <div class="link-attachments">
                    ${p.links.map(l => `<span class="chat-link">🔗 ${esc(l)}</span>`).join('')}
                  </div>
                ` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="inject-panel">
        <div class="inject-header">
          <span class="inject-title"><b>Simulation Test Ingestion:</b> Feed test utterances into pipeline (marked is_mock)</span>
          <div class="preset-dropdown-wrap">
            <select id="injectPresets" class="select-preset">
              <option value="">Quick Preset Frauds &amp; Benign…</option>
              <option value="Aap ab digital arrest mein hain. Camera on rakhiye, call cut mat karna.">Digital Arrest Order</option>
              <option value="Main Mumbai Police Cyber Crime branch se Inspector Sharma bol raha hoon.">Police Authority Claim</option>
              <option value="Aapke against non-bailable arrest warrant nikla hai, jail jaana padega.">Legal & Arrest Threat</option>
              <option value="Abhi verification ke liye 2 lakh rupaye RBI account mein transfer kijiye.">Immediate Money Demand</option>
              <option value="Bank KYC update ke liye jo OTP aaya hai woh turant bataiye.">OTP Credential Request</option>
              <option value="Arre yaar, kal meeting kitne baje hai? Document check kar lo.">Benign Conversation</option>
            </select>
          </div>
        </div>

        <form id="injectForm" class="inject-form">
          <div class="inject-inputs">
            <input type="text" id="injectTextInput" class="input-text flex-1" placeholder="Enter Hindi/Hinglish speech or chat text e.g. 'Aap digital arrest mein hain'…" required />
            <select id="injectRoleSelect" class="select-field">
              <option value="remote">Remote (Scammer)</option>
              <option value="local">Local (Victim / Protected)</option>
              <option value="unknown">Unknown</option>
            </select>
            <button type="submit" class="btn btn-secondary" id="btnInject">Inject</button>
          </div>
        </form>
      </div>
    `;

    this._bindEvents(sessionId);
    if (this.autoScroll) {
      const feed = document.getElementById('transcriptFeed');
      if (feed) feed.scrollTop = feed.scrollHeight;
    }
  }

  _bindEvents(sessionId) {
    const filterBtns = this.container.querySelectorAll('.filter-btn');
    filterBtns.forEach(btn => {
      btn.onclick = () => {
        this.filter = btn.dataset.filter;
        const autoScrollCheck = document.getElementById('autoScrollCheck');
        if (autoScrollCheck) this.autoScroll = autoScrollCheck.checked;
        const feed = document.getElementById('transcriptFeed');
        const scrollPos = feed ? feed.scrollTop : 0;
        this.render();
      };
    });

    const autoScrollCheck = document.getElementById('autoScrollCheck');
    if (autoScrollCheck) {
      autoScrollCheck.onchange = (e) => {
        this.autoScroll = e.target.checked;
      };
    }

    const presetSelect = document.getElementById('injectPresets');
    if (presetSelect) {
      presetSelect.onchange = (e) => {
        const val = e.target.value;
        if (val) {
          const input = document.getElementById('injectTextInput');
          if (input) input.value = val;
        }
      };
    }

    const form = document.getElementById('injectForm');
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const input = document.getElementById('injectTextInput');
        const roleSelect = document.getElementById('injectRoleSelect');
        const text = input ? input.value.trim() : '';
        const role = roleSelect ? roleSelect.value : 'remote';

        if (!text) return;
        if (!sessionId) {
          alert('Please pick or create an active session first.');
          return;
        }

        const btn = document.getElementById('btnInject');
        btn.disabled = true;
        try {
          if (this.onInjectText) {
            await this.onInjectText(sessionId, text, role);
            if (input) input.value = '';
          }
        } catch (err) {
          alert(`Injection failed: ${err.message}`);
        } finally {
          btn.disabled = false;
        }
      };
    }
  }
}

