// Self-check test suite for CallShield PII redaction & identifier retention
// Run with: node frontend/js/redact.selftest.mjs

import { redactSensitiveText, extractKeptIdentifiers } from './formatters.js';

const tests = [
  {
    name: 'BUG 1: Card number leaks (privacy) - 16-digit card runs before Aadhaar',
    fn: () => {
      const input = 'Card 4111 1111 1111 1111 ka CVV';
      const actual = redactSensitiveText(input, false);
      const expected = 'Card [REDACTED_CARD] ka CVV';
      return { pass: actual === expected, actual, expected };
    },
  },
  {
    name: 'BUG 2: OTP in natural Hinglish with intervening words',
    fn: () => {
      const input = 'Jo OTP aaya hai 482913 woh bataiye';
      const actual = redactSensitiveText(input, false);
      const expected = 'Jo OTP aaya hai [REDACTED_OTP] woh bataiye';
      return { pass: actual === expected, actual, expected };
    },
  },
  {
    name: 'BUG 3: False OTP match inside words (e.g. pincode)',
    fn: () => {
      const input = 'Courier ka pincode 411001 hai';
      const actual = redactSensitiveText(input, false);
      const expected = 'Courier ka pincode 411001 hai';
      return { pass: actual === expected, actual, expected };
    },
  },
  {
    name: 'BUG 4 (remote): Scammer 12-digit account kept, not hidden as Aadhaar',
    fn: () => {
      const input = 'A/c 123456789012 mein transfer karo';
      const actual = redactSensitiveText(input, false);
      const expected = 'A/c 123456789012 mein transfer karo';
      const kept = extractKeptIdentifiers(actual);
      const pass = actual === expected && kept.includes('A/c 123456789012');
      return { pass, actual: `${actual} (kept: ${JSON.stringify(kept)})`, expected: `${expected} (kept: ["A/c 123456789012"])` };
    },
  },
  {
    name: 'BUG 4 (local): Local victim 12-digit account redacted',
    fn: () => {
      const input = 'A/c 123456789012 mein transfer karo';
      const actual = redactSensitiveText(input, true);
      const expected = 'A/c [REDACTED_ACCOUNT] mein transfer karo';
      return { pass: actual === expected, actual, expected };
    },
  },
  {
    name: 'Regression 1: Remote account with IFSC unchanged and kept',
    fn: () => {
      const input = 'Pay ... to A/c 50100231234567 IFSC HDFC0001234';
      const actual = redactSensitiveText(input, false);
      const expected = 'Pay ... to A/c 50100231234567 IFSC HDFC0001234';
      const kept = extractKeptIdentifiers(actual);
      const pass = actual === expected && kept.includes('A/c 50100231234567');
      return { pass, actual: `${actual} (kept: ${JSON.stringify(kept)})`, expected: `${expected} (kept: ["A/c 50100231234567"])` };
    },
  },
  {
    name: 'Regression 2: Remote UPI ID and phone kept in evidence',
    fn: () => {
      const input = 'Paise verify.rbi@upi pe bhejo, ya 9876543210 pe call karo';
      const actual = redactSensitiveText(input, false);
      const expected = 'Paise verify.rbi@upi pe bhejo, ya 9876543210 pe call karo';
      const kept = extractKeptIdentifiers(actual);
      const pass = actual === expected && kept.includes('verify.rbi@upi') && kept.includes('9876543210');
      return { pass, actual: `${actual} (kept: ${JSON.stringify(kept)})`, expected: `${expected} (kept: verify.rbi@upi, 9876543210)` };
    },
  },
  {
    name: 'Regression 3: Local victim phone and email redacted',
    fn: () => {
      const input = 'Mera number 9876543210 hai aur email raj@gmail.com';
      const actual = redactSensitiveText(input, true);
      const expected = 'Mera number [REDACTED_PHONE] hai aur email [REDACTED_EMAIL]';
      return { pass: actual === expected, actual, expected };
    },
  },
  {
    name: 'Regression 4: Aadhaar 12-digit formatted number redacted',
    fn: () => {
      const input = 'Aapka Aadhaar 1234 5678 9012 block hoga';
      const actual = redactSensitiveText(input, false);
      const expected = 'Aapka Aadhaar [REDACTED_AADHAAR] block hoga';
      return { pass: actual === expected, actual, expected };
    },
  },
];

let failed = 0;
console.log('--- CallShield Redaction & Identifier Self-Check ---');

for (const t of tests) {
  const res = t.fn();
  if (res.pass) {
    console.log(`[PASS] ${t.name}`);
  } else {
    failed++;
    console.error(`[FAIL] ${t.name}`);
    console.error(`       Expected: ${res.expected}`);
    console.error(`       Actual:   ${res.actual}`);
  }
}

console.log('----------------------------------------------------');
if (failed === 0) {
  console.log(`ALL ${tests.length} TESTS PASSED.`);
  process.exit(0);
} else {
  console.error(`${failed} / ${tests.length} TESTS FAILED.`);
  process.exit(1);
}
