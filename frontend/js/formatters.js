// CallShield Utility Formatters & Security Sanitizers

export function esc(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export function fmtTime(ms) {
  if (!ms) return '–';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '–';
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDateTime(ms) {
  if (!ms) return '–';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '–';
  return d.toLocaleString([], {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

export function fmtCurrencyINR(amount) {
  const num = Number(amount) || 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(num);
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function getRiskColorClass(level, monitoringState) {
  if (monitoringState && monitoringState !== 'ok' && level === 'normal') {
    return 'unavailable';
  }
  switch ((level || '').toLowerCase()) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'caution': return 'caution';
    case 'normal': return 'normal';
    default: return 'unavailable';
  }
}

export const CATEGORY_DESCRIPTIONS = {
  authority_claim: 'Impersonation of Police, CBI, Customs, RBI or Bank Official',
  legal_threat: 'Threatens arrest warrant, FIR or immediate prosecution',
  digital_arrest_claim: 'Claims victim is placed under online/digital arrest',
  credential_request: 'Demands OTP, PIN, UPI code or account password',
  kyc_card_request: 'Demands bank card, KYC document or net-banking login',
  payment_demand: 'Demands immediate money transfer to "verification/safe" account',
  remote_access_request: 'Requests installation of AnyDesk, TeamViewer or screen sharing',
  video_custody: 'Orders victim to keep camera on and stay on video call',
  secrecy_isolation: 'Commands victim to isolate, stay alone, not tell family or lawyer',
  online_documents: 'Sends forged FIRs, warrants or police credentials as "proof"',
  channel_switch: 'Pressures victim to shift communication to WhatsApp or Telegram',
  urgency_pressure: 'Creates panic, severe deadlines and urgency ("turant", "abhi")',
  hook_story: 'Fabricates story of parcel with drugs/passports or compromised identity',
  link_request: 'Directs victim to malicious verification or payment link',
  unsolicited_pressure: 'Unprompted pressure for private personal or banking data',
  visual_uniform: 'Police-style uniform on camera',
  visual_insignia: 'Government insignia / office backdrop',
  visual_official_document: 'Warrant / FIR-style document shown',
  visual_payment_instruction: 'Payment details shown on screen',
};

// Map backend fraud categories to official Chakshu categories
export const CHAKSHU_CATEGORY_MAP = {
  authority_claim: 'Impersonation as Police, CBI, Customs, Aadhaar, RBI etc.',
  legal_threat: 'Impersonation as Police, CBI, Customs, Aadhaar, RBI etc.',
  digital_arrest_claim: 'Impersonation as Police, CBI, Customs, Aadhaar, RBI etc.',
  credential_request: 'KYC and Payment related to Bank / Electricity / Gas / Insurance etc.',
  kyc_card_request: 'KYC and Payment related to Bank / Electricity / Gas / Insurance etc.',
  payment_demand: 'KYC and Payment related to Bank / Electricity / Gas / Insurance etc.',
  link_request: 'Malicious link / website',
  remote_access_request: 'Any Other Suspected Fraud',
  video_custody: 'Any Other Suspected Fraud',
  secrecy_isolation: 'Any Other Suspected Fraud',
  online_documents: 'Impersonation as Police, CBI, Customs, Aadhaar, RBI etc.',
  channel_switch: 'Any Other Suspected Fraud',
  urgency_pressure: 'Any Other Suspected Fraud',
  hook_story: 'Any Other Suspected Fraud',
  unsolicited_pressure: 'Any Other Suspected Fraud',
  visual_uniform: 'Impersonation as Police, CBI, Customs, Aadhaar, RBI etc.',
  visual_insignia: 'Impersonation as Police, CBI, Customs, Aadhaar, RBI etc.',
  visual_official_document: 'Impersonation as Police, CBI, Customs, Aadhaar, RBI etc.',
  visual_payment_instruction: 'KYC and Payment related to Bank / Electricity / Gas / Insurance etc.',
};

export function redactSensitiveText(text, isLocal = false) {
  if (!text) return '';
  let out = text;

  // 1. Account numbers preceded within ~15 chars by a/c, acct, account, khata, खाता
  const accPrefixRe = /(?<![\w\u0900-\u097F])(a\/c|acct|account|khata|खाता)(?![\w\u0900-\u097F])([^\d\n]{0,15})(\d{9,18})\b/giu;
  const keptAccounts = [];

  if (isLocal) {
    out = out.replace(accPrefixRe, (m, g1, g2) => g1 + g2 + '[REDACTED_ACCOUNT]');
  } else {
    // Protect remote account numbers so Aadhaar / other rules won't touch them
    out = out.replace(accPrefixRe, (m, g1, g2, digits) => {
      keptAccounts.push(digits);
      return g1 + g2 + '__KEPT_ACC_' + (keptAccounts.length - 1) + '__';
    });
  }

  // 2. 16-digit card numbers (runs BEFORE 12-digit Aadhaar to avoid Aadhaar eating first 12 digits)
  out = out.replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, '[REDACTED_CARD]');

  // 3. 12-digit Aadhaar numbers
  out = out.replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[REDACTED_AADHAAR]');

  // 4. OTP / PIN in natural Hinglish with whole-word keywords
  const otpRe = /(?<![\w\u0900-\u097F])(otp|one[- ]time password|code|pin|ओटीपी|कोड|पिन)(?![\w\u0900-\u097F])([^\d\n]{0,25})(\d{4,8})\b/giu;
  out = out.replace(otpRe, (m, g1, g2) => g1 + g2 + '[REDACTED_OTP]');

  // 5. Local victim identifiers (privacy protection)
  if (isLocal) {
    out = out
      // 10-digit Indian mobile numbers
      .replace(/\b[6-9]\d{9}\b/g, '[REDACTED_PHONE]')
      // Email addresses
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
      // UPI IDs
      .replace(/\b[a-zA-Z0-9.\-_]{2,}@(upi|okaxis|okhdfcbank|oksbi|paytm|icici|ybl|axl|ibl|barodampay|federal)\b/gi, '[REDACTED_UPI]')
      // Any remaining standalone account numbers for local victim
      .replace(/\b\d{9,18}\b/g, '[REDACTED_ACCOUNT]');
  }

  // 6. Restore protected remote account numbers
  if (!isLocal) {
    for (let i = 0; i < keptAccounts.length; i++) {
      out = out.replace('__KEPT_ACC_' + i + '__', keptAccounts[i]);
    }
  }

  return out;
}

export function extractKeptIdentifiers(text) {
  if (!text) return [];
  const found = new Set();

  // Mobile phones
  const phones = text.match(/\b[6-9]\d{9}\b/g) || [];
  phones.forEach(p => found.add(p));

  // Emails and UPI IDs
  const emails = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) || [];
  emails.forEach(e => found.add(e));

  const upis = text.match(/\b[a-zA-Z0-9.\-_]{2,}@(upi|okaxis|okhdfcbank|oksbi|paytm|icici|ybl|axl|ibl|barodampay|federal)\b/gi) || [];
  upis.forEach(u => found.add(u));

  // Account numbers with context
  const accPrefixRe = /(?<![\w\u0900-\u097F])(a\/c|acct|account|khata|खाता)(?![\w\u0900-\u097F])([^\d\n]{0,15})(\d{9,18})\b/giu;
  let m;
  while ((m = accPrefixRe.exec(text)) !== null) {
    found.add(m[0].trim());
  }

  return Array.from(found);
}

