"""SIMULATED bank. No real banking system is contacted.

Transfers start PENDING and settle after a delay. If the call's risk policy freezes the
session, pending transfers move to HOLD, and new ones are held (or declined at critical).
Each freeze carries an HMAC-signed risk attestation the "bank" could verify.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from typing import Any

from .contracts import new_id, now_ms
from .store import Store


class MockBank:
    def __init__(self, store: Store, secret: str | None = None, settle_after_ms: int = 30000):
        self.store = store
        self.secret = (secret or secrets.token_hex(32)).encode()
        self.settle_after_ms = settle_after_ms

    def sign(self, claims: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(claims, sort_keys=True, separators=(",", ":"))
        sig = hmac.new(self.secret, body.encode(), hashlib.sha256).hexdigest()
        return {"claims": claims, "alg": "HS256", "signature": sig}

    def verify(self, attestation: dict[str, Any]) -> bool:
        expected = self.sign(attestation["claims"])["signature"]
        return hmac.compare_digest(expected, attestation.get("signature", ""))

    def is_frozen(self, session_id: str) -> bool:
        return bool(self.store.execute("SELECT 1 FROM bank_freezes WHERE session_id=?", (session_id,)))

    def freeze(self, session_id: str, claims: dict[str, Any]) -> dict[str, Any]:
        att = self.sign(claims)
        t = now_ms()
        self.store.execute(
            "INSERT OR IGNORE INTO bank_freezes(session_id, frozen_ms, attestation) VALUES (?,?,?)",
            (session_id, t, json.dumps(att)),
        )
        self.store.execute(
            "UPDATE transfers SET status='HOLD', updated_ms=?, reason=?, attestation=? "
            "WHERE session_id=? AND status='PENDING'",
            (t, "Held: live call flagged as likely fraud", json.dumps(att), session_id),
        )
        return att

    def create_transfer(self, session_id: str, amount: float, payee: str,
                        risk_level: str | None) -> dict[str, Any]:
        t = now_ms()
        tid = new_id("txn")
        status, reason = "PENDING", "Awaiting settlement"
        att = "{}"
        if self.is_frozen(session_id):
            row = self.store.execute("SELECT attestation FROM bank_freezes WHERE session_id=?", (session_id,))
            att = row[0]["attestation"]
            if risk_level == "critical":
                status, reason = "DECLINED", "Declined: payee contact during a critical-risk call"
            else:
                status, reason = "HOLD", "Held: live call flagged as likely fraud"
        self.store.execute(
            "INSERT INTO transfers(transfer_id, session_id, amount, payee, status, created_ms, updated_ms, reason, attestation) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (tid, session_id, amount, payee, status, t, t, reason, att),
        )
        return self.get(tid)

    def release(self, transfer_id: str) -> dict[str, Any] | None:
        self.store.execute(
            "UPDATE transfers SET status='RELEASED', updated_ms=?, reason='Released by account holder after review' "
            "WHERE transfer_id=? AND status='HOLD'",
            (now_ms(), transfer_id),
        )
        return self.get(transfer_id)

    def settle(self) -> int:
        t = now_ms()
        rows = self.store.execute(
            "UPDATE transfers SET status='ALLOWED', updated_ms=?, reason='Settled (no risk hold)' "
            "WHERE status='PENDING' AND created_ms <= ? RETURNING transfer_id",
            (t, t - self.settle_after_ms),
        )
        return len(rows)

    def get(self, transfer_id: str) -> dict[str, Any] | None:
        rows = self.store.execute("SELECT * FROM transfers WHERE transfer_id=?", (transfer_id,))
        return self._row(rows[0]) if rows else None

    def list(self, session_id: str | None = None) -> list[dict[str, Any]]:
        if session_id:
            rows = self.store.execute(
                "SELECT * FROM transfers WHERE session_id=? ORDER BY created_ms DESC", (session_id,))
        else:
            rows = self.store.execute("SELECT * FROM transfers ORDER BY created_ms DESC LIMIT 100")
        return [self._row(r) for r in rows]

    @staticmethod
    def _row(r) -> dict[str, Any]:
        d = dict(r)
        d["attestation"] = json.loads(d["attestation"])
        d["simulated"] = True
        return d
