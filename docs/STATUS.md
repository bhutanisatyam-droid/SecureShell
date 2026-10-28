# Deliverable status

Labels: **verified** (reproducible test passes), **implemented** (code written, not yet run on real Meet),
**simulated** (deliberately not real), **blocked**, **pending** (waiting on Shlok's models).

## PS1 mandatory deliverables

| # | Deliverable | Status | Notes |
|---|---|---|---|
| 1 | Fraud detection with red flag from spoken terms over calls | implemented | Live pipeline: Sarvam saaras:v4 codemix streaming ASR → Groq gpt-oss-120b contextual detector (`backend/callshield/ai/`). Text-level dev metrics in `eval/results/`; live Meet run pending. |
| 1 | …and received messages during calls | verified on real Meet | Meet chat DOM observer (`[data-message-id]`); must be validated on the live Meet UI. |
| 1 | …video: documents / IDs / uniforms shown on the call | implemented, verified by replay | Gemini vision on gated frames (new scene settled, ≤1 per 10 s, plus once a minute; ~2 calls in a 25 s test call). Document text joins the transcript and is judged in context; appearance cues are capped modifiers. Never judges authenticity. Planned architecture: local YOLO-World + OCR trigger with Gemini only on detected crops (not built: no bandwidth for the ~3–4 GB model download). |
| 2 | POC-level solution | implemented | |
| 3 | Disconnect call | verified (manual), auto pending | Leave button click (icon `call_end` / aria-label) with verification; opt-in close-tab fallback. |
| 3 | Switch off mobile | **simulated / not met** | Not possible from desktop Chrome. Stated as a limitation. |
| 3 | Automated reporting to central server | verified (simulator) | Every event persisted; incident report at `/api/sessions/{id}/report`. Not filed with any authority. |
| 3 | Freeze transactions during call | simulated, verified (simulator) | Mock bank: PENDING → HOLD/DECLINED on policy freeze, HMAC-signed risk attestation. |
| 4 | Demo on at least one attack call | pending | Needs live Meet run + Shlok's pipeline. |
| 5 | Accuracy, FP, FN, latency | dev-set only | `eval/run_text_eval.py`: rules baseline 62.5% acc / 50% FPR vs LLM 100% / 0% on the **dev set the prompt was tuned on** (optimistic). Audio replay: speech end → flag ≈ 1–3 s; Sarvam transcript ≈ 0.1 s after end of speech. Held-out set still needed. |

## Platform (Satyam) P0

| Item | Status |
|---|---|
| Contract v1.0, binary framing | verified (unit tests) |
| Ingest WS, auth token, validation, per-modality bounded queues | verified (tests + simulator) |
| Fusion engine (dedupe, per-category max, speaker factor, modality caps, weak-only cap, patterns) | verified (unit tests) |
| Policy (bank hold at high; auto-disconnect gate; separated from scoring) | verified (unit tests) |
| Monitoring states (`ok/degraded/unavailable`, never "safe" when impaired) | verified (tests) |
| Dashboard | verified (live Meet session, 2026-10-28) |
| Extension tab audio capture + playback restore | verified on real Meet (2026-10-28) |
| Extension video frame sampling | verified on real Meet (2026-10-28) |
| Meet chat ingest | verified on real Meet (2026-10-28) |
| Optional local mic (separate permission page) | implemented, not yet exercised |
| Overlay | verified on real Meet (2026-10-28) |
| Manual End call from dashboard → left Meet | verified on real Meet (2026-10-28) |
| Auto-disconnect with cancel window | implemented, **untested on Meet** (gate blocks mock inference) |

## Known risks to check first on a real Meet call

1. `getMediaStreamId` from the popup + `getUserMedia` in the offscreen document (Chrome ≥ 116).
2. Tab still audible to the user while captured.
3. Chat messages: Meet only renders them while the chat panel is open; toasts may use other markup.
4. Leave button selector on the current Meet UI and in a Hindi-language UI.
5. Echo: with speakers, the mic re-captures remote audio and labels it `local`. Use headphones.
