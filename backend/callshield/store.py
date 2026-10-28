"""SQLite persistence. Media bytes are never stored, only event metadata and evidence."""

from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any

from .contracts import Envelope

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id   TEXT PRIMARY KEY,
    created_ms   INTEGER NOT NULL,
    ended_ms     INTEGER,
    settings     TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    source       TEXT NOT NULL,
    body         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, event_type, id);
CREATE TABLE IF NOT EXISTS transfers (
    transfer_id  TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    amount       REAL NOT NULL,
    payee        TEXT NOT NULL,
    status       TEXT NOT NULL,
    created_ms   INTEGER NOT NULL,
    updated_ms   INTEGER NOT NULL,
    reason       TEXT NOT NULL DEFAULT '',
    attestation  TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS bank_freezes (
    session_id   TEXT PRIMARY KEY,
    frozen_ms    INTEGER NOT NULL,
    attestation  TEXT NOT NULL
);
"""


class Store:
    def __init__(self, path: str):
        self._lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        if path != ":memory:":
            self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def execute(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            cur = self.conn.execute(sql, params)
            rows = cur.fetchall()
            self.conn.commit()
            return rows

    def upsert_session(self, session_id: str, created_ms: int, settings: dict) -> None:
        self.execute(
            "INSERT INTO sessions(session_id, created_ms, settings) VALUES (?,?,?) "
            "ON CONFLICT(session_id) DO UPDATE SET settings=excluded.settings, ended_ms=NULL",
            (session_id, created_ms, json.dumps(settings)),
        )

    def end_session(self, session_id: str, ended_ms: int) -> None:
        self.execute("UPDATE sessions SET ended_ms=? WHERE session_id=?", (ended_ms, session_id))

    def sessions(self) -> list[dict[str, Any]]:
        rows = self.execute("SELECT * FROM sessions ORDER BY created_ms DESC LIMIT 50")
        return [dict(r) | {"settings": json.loads(r["settings"])} for r in rows]

    def add_event(self, env: Envelope) -> None:
        self.execute(
            "INSERT INTO events(event_id, session_id, event_type, timestamp_ms, source, body) "
            "VALUES (?,?,?,?,?,?)",
            (env.event_id, env.session_id, env.event_type, env.timestamp_ms, env.source,
             env.model_dump_json()),
        )

    def events(self, session_id: str, event_types: list[str] | None = None,
               limit: int = 1000) -> list[dict[str, Any]]:
        sql = "SELECT body FROM events WHERE session_id=?"
        params: list[Any] = [session_id]
        if event_types:
            sql += f" AND event_type IN ({','.join('?' * len(event_types))})"
            params += event_types
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        rows = self.execute(sql, tuple(params))
        return [json.loads(r["body"]) for r in reversed(rows)]

    def close(self) -> None:
        with self._lock:
            self.conn.close()
