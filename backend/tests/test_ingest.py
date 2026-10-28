import json
import time

import pytest
from fastapi.testclient import TestClient

from callshield import framing
from callshield.contracts import make_event, now_ms
from callshield.adapter import MockPipeline
from callshield.main import create_app

TOKEN = "t"
SID = "test-001"


@pytest.fixture
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "t.db"), token=TOKEN, tick_s=0.2, pipeline=MockPipeline())
    with TestClient(app) as c:
        yield c


def audio_frame(seq):
    t = now_ms()
    env = make_event(SID, "audio_chunk", "meet_tab", {
        "seq": seq, "t_start_ms": t - 200, "t_end_ms": t, "sample_rate_hz": 16000,
        "channels": 1, "encoding": "pcm_s16le", "speaker_role": "remote"})
    return framing.encode(env.model_dump(), b"\x00\x00" * 3200)


def chat(mid, text):
    return make_event(SID, "chat_message", "meet_chat", {
        "message_id": mid, "t_ms": now_ms(), "text": text, "sender_role": "remote"}).model_dump_json()


def recv_until(ws, pred, limit=50):
    for _ in range(limit):
        msg = json.loads(ws.receive_text())
        if pred(msg):
            return msg
    raise AssertionError("expected message not received")


def test_framing_roundtrip():
    h, b = framing.decode(framing.encode({"a": 1}, b"xyz"))
    assert h == {"a": 1} and b == b"xyz"
    for bad in (b"", b"\x00\x00\x00\x05ab", b"\x00\x00\x00\x02[]"):
        with pytest.raises(framing.FrameError):
            framing.decode(bad)


def test_rejects_bad_token(client):
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/ingest?token=nope&session_id={SID}") as ws:
            ws.receive_text()


def test_end_to_end_chat_to_assessment(client):
    with client.websocket_connect(f"/ws/ingest?token={TOKEN}&session_id={SID}") as ws:
        ws.send_text(make_event(SID, "control", "extension", {
            "command": "session_start", "details": {"auto_disconnect": False}}).model_dump_json())
        ws.send_bytes(audio_frame(0))
        ws.send_bytes(b"garbage")
        ws.send_text(chat("m1", "Aap digital arrest mein hain, call disconnect mat karna"))
        ws.send_text(chat("m1", "duplicate id is ignored"))
        a = recv_until(ws, lambda m: m["event_type"] == "assessment" and m["payload"]["risk_index"] > 0)
        p = a["payload"]
        assert p["inference_mode"] == "mock"
        assert "digital_arrest_claim" in p["categories"]

        detail = client.get(f"/api/sessions/{SID}?token={TOKEN}").json()
        c = detail["health"]["counters"]
        assert c["audio_chunks_meet_tab"] == 1
        assert c["rejected_bad_binary_frame"] == 1
        assert c["chat_duplicates"] == 1


def test_inject_and_report_and_bank_hold(client):
    with client.websocket_connect(f"/ws/ingest?token={TOKEN}&session_id={SID}") as ws:
        ws.send_text(make_event(SID, "control", "extension", {
            "command": "session_start", "details": {}}).model_dump_json())
        ws.send_bytes(audio_frame(0))
        tx = client.post(f"/api/bank/transfers?token={TOKEN}",
                         json={"session_id": SID, "amount": 50000, "payee": "x@upi"}).json()
        assert tx["status"] == "PENDING" and tx["simulated"] is True
        for text in ["Main CBI officer bol raha hoon",
                     "Aap digital arrest mein hain",
                     "Abhi verification ke liye paise transfer karna padega",
                     "camera on rakhiye, call disconnect mat karna"]:
            r = client.post(f"/api/sessions/{SID}/inject_text?token={TOKEN}", json={"text": text})
            assert r.status_code == 200
        recv_until(ws, lambda m: m["event_type"] == "assessment" and m["payload"]["risk_level"] == "critical")
        time.sleep(0.3)
        tx2 = client.get(f"/api/bank/transfers?token={TOKEN}&session_id={SID}").json()[0]
        assert tx2["status"] == "HOLD"
        assert client.post(f"/api/bank/verify?token={TOKEN}", json=tx2["attestation"]).json()["valid"]

        rep = client.get(f"/api/sessions/{SID}/report?token={TOKEN}").json()
        assert rep["official_complaint_submitted"] is False
        assert rep["peak_assessment"]["risk_level"] == "critical"
        assert any(a["action_type"] == "bank_hold" for a in rep["actions"])
        # mock inference never auto-disconnects with default config
        assert not any(a["action_type"] == "auto_disconnect" for a in rep["actions"])


def test_evidence_with_unresolved_ref_is_rejected(client):
    with client.websocket_connect(f"/ws/ingest?token={TOKEN}&session_id={SID}") as ws:
        ws.send_text(make_event(SID, "control", "extension", {
            "command": "session_start", "details": {}}).model_dump_json())
        ws.send_bytes(audio_frame(0))
        time.sleep(0.1)
        session = client.app.state.manager.sessions[SID]
        bogus = make_event(SID, "evidence", "model", {
            "evidence_id": "ev-x", "category": "payment_demand", "source_modality": "speech",
            "t_start_ms": 0, "t_end_ms": 0, "source_event_ids": ["does-not-exist"],
            "quoted_text_or_observation": "invented"})
        client.portal.call(session._emit, bogus)
        assert session.counters["rejected_unresolved_evidence_ref"] == 1
        assert "ev-x" not in session.engine.entries


def test_monitoring_unavailable_without_extension(client):
    with client.websocket_connect(f"/ws/ingest?token={TOKEN}&session_id={SID}") as ws:
        ws.send_text(make_event(SID, "control", "extension", {
            "command": "session_start", "details": {}}).model_dump_json())
        time.sleep(0.1)
    time.sleep(0.1)
    h = client.get(f"/api/sessions/{SID}?token={TOKEN}").json()["health"]
    assert h["monitoring_state"] == "unavailable"


def test_opt_in_reaches_extension_as_auto_disconnect(tmp_path):
    import re
    cfg = open("risk_config.yaml", encoding="utf-8").read()
    cfg = re.sub(r"allow_on_mock: \w+", "allow_on_mock: true", cfg)
    cfg = re.sub(r"sustain_ms: \d+", "sustain_ms: 0", cfg)
    cfg_path = tmp_path / "risk.yaml"
    cfg_path.write_text(cfg, encoding="utf-8")
    app = create_app(db_path=str(tmp_path / "t.db"), token=TOKEN, tick_s=0.2, config_path=str(cfg_path), pipeline=MockPipeline())
    with TestClient(app) as c, c.websocket_connect(f"/ws/ingest?token={TOKEN}&session_id={SID}") as ws:
        ws.send_text(make_event(SID, "control", "extension", {
            "command": "session_start", "details": {"auto_disconnect": True}}).model_dump_json())
        ws.send_bytes(audio_frame(0))
        for i, text in enumerate(["Main CBI officer bol raha hoon", "Aap digital arrest mein hain",
                                  "Camera on rakhiye, call disconnect mat karna",
                                  "Abhi verification ke liye paise transfer karna padega"]):
            ws.send_text(chat(f"m{i}", text))
        act = recv_until(ws, lambda m: m["event_type"] == "action")
        assert act["payload"]["action_type"] == "auto_disconnect"
        assert act["payload"]["status"] == "pending"
        h = c.get(f"/api/sessions/{SID}?token={TOKEN}").json()["health"]
        assert h["session_start_received"] is True


def test_retraction_lowers_risk(client):
    with client.websocket_connect(f"/ws/ingest?token={TOKEN}&session_id={SID}") as ws:
        ws.send_text(make_event(SID, "control", "extension", {
            "command": "session_start", "details": {}}).model_dump_json())
        ws.send_bytes(audio_frame(0))
        ws.send_text(chat("m1", "Aap digital arrest mein hain, call disconnect mat karna"))
        recv_until(ws, lambda m: m["event_type"] == "assessment" and m["payload"]["risk_index"] > 0)
        session = client.app.state.manager.sessions[SID]
        for _ in range(100):  # the mock emits 3 items for this message (arrest, legal, custody)
            if session.counters["evidence"] >= 3:
                break
            time.sleep(0.05)
        ids = list(session.engine.entries)
        assert len(ids) == 3
        client.portal.call(session._emit, make_event(SID, "retraction", "model", {
            "retraction_id": "ret-1", "evidence_ids": ids, "reason": "it was a joke"}))
        b = recv_until(ws, lambda m: m["event_type"] == "assessment" and m["payload"]["risk_index"] == 0)
        assert b["payload"]["risk_level"] == "normal"
        assert session.counters["retractions"] == 1
