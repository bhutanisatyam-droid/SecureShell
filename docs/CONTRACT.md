# Event contract v1.0 (Satyam ⇄ Shlok)

Source of truth: [`backend/callshield/contracts.py`](../backend/callshield/contracts.py). Changes need a version bump and a joint review.

## Transport

- Extension → backend: `ws://HOST/ws/ingest?token=…&session_id=…`
  - **Media** (audio_chunk, video_frame): one binary WS message =
    `uint32 big-endian header length` + `UTF-8 JSON envelope` + `raw bytes`.
  - **Everything else**: JSON text message containing the envelope.
- Backend → extension (same socket): `assessment` and `action` envelopes as JSON text.
- Dashboard: `ws://HOST/ws/dashboard?token=…` streams `{kind: "event"|"health", ...}`.

## Media formats

| | Format |
|---|---|
| Audio | PCM signed 16-bit little-endian, mono, 16 kHz, 200 ms chunks (6400 bytes) |
| Audio timestamps | Derived from the sample count since the first chunk of that track (epoch ms) |
| Video | JPEG q≈0.8, max 1920 px wide, one frame every ~2 s, rendered Meet tab (not per-participant). Optional `change_score` (0–1, grayscale thumbnail difference vs the previous frame) lets the backend analyse only settled new scenes. |

## Speaker roles

`remote | local | unknown`, never `caller`/`victim`.

- `meet_tab` audio = everything the tab plays = **all remote participants mixed** → `remote`.
- `local_mic` audio = the protected user (optional, separate permission) → `local`.
- Chat sender is `unknown` unless reliably known.
- Fusion gives `local` text evidence weight 0 and `unknown` 0.7 (config).

## What the AI pipeline implements

```python
class Pipeline:                      # CALLSHIELD_PIPELINE=your_module:Pipeline
    name: str; is_mock: bool
    async def start_session(self, session_id, emit): ...      # keep `emit`, call it with Envelopes
    async def on_audio(self, session_id, event_id, chunk: AudioChunk, pcm: bytes): ...
    async def on_video(self, session_id, event_id, frame: VideoFrame, jpeg: bytes): ...
    async def on_chat(self, session_id, event_id, msg: ChatMessage): ...
    async def on_text(self, session_id, event_id, utt: Utterance): ...   # injected/replayed text
    async def end_session(self, session_id): ...
    def health(self) -> dict: ...                              # {"ok": bool, "detail": str}
```

Each `on_*` call has a 10 s timeout and runs on its own per-modality worker (video never blocks audio).
Exceptions/timeouts mark monitoring `degraded` for 15 s; `health()["ok"] == False` → `unavailable`.

Emit, in this order:

1. `utterance` (source `model`) for each final ASR segment, with `speaker_role` copied from the audio chunk.
2. `evidence` (source `model`) referencing **existing** ids in `source_event_ids`
   (audio chunk event ids, utterance ids/event ids, chat message ids/event ids, frame event ids).

3. `retraction` (source `model`) `{retraction_id, evidence_ids, reason}` when later context shows earlier
   evidence was not a direct act (a story, lesson, quote or joke). The fusion engine drops it and re-scores;
   if an auto-disconnect countdown is running and risk falls below critical, the backend cancels it.

Evidence is **rejected** if: the category is not in `risk_config.yaml`, any reference is unknown,
or the payload fails validation. Rejections are counted on the dashboard.

`quality` is optional 0–1 and is multiplied into the weight. It is not treated as a calibrated probability.

## Categories

Defined in `risk_config.yaml`: behaviour categories (`authority_claim`, `legal_threat`,
`digital_arrest_claim`, `credential_request`, `kyc_card_request`, `payment_demand`,
`remote_access_request`, `video_custody`, `secrecy_isolation`, `online_documents`, `channel_switch`,
`urgency_pressure`, `hook_story`, `link_request`, `unsolicited_pressure`) plus visual (`visual_*`) and
tone (`tone_intimidation`) modifiers. R1–R13 are references attached to categories, not scoring units.
