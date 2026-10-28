# Evaluation

Three levels, reported separately so ASR errors and detection errors are not mixed up.

| Level | Tool | Measures |
|---|---|---|
| Text | `run_text_eval.py` | Detector + fusion on transcript lines (no ASR). Accuracy, FP, FN, precision, recall, LLM latency. |
| Audio replay | `../integration_tests/replay_audio.py` | Full backend with real Sarvam ASR + detector, audio streamed in real time. ASR lag, speech-end → flag, time to HIGH/CRITICAL. |
| Live Meet | the extension | Same as replay plus capture, overlay, disconnect. `warning_shown` events give assessment → on-screen latency. |

## Data

- `dev_conversations.yaml`: 12 scams + 12 hard negatives, **authored by the same people/assistant who wrote the detector prompt**. Tuning only; numbers on it are optimistic.
- `heldout_conversations.yaml` (to create): written by someone who has **not** seen the prompt or dev set: realistic scam calls (YouTube scam-call recordings transcribed, news reports, I4C advisories) and normal calls. Same format. Report final metrics on this set only, and do not change the prompt or config after looking at it.
- `audio/`: Sarvam TTS renderings of dev conversations (`make_tts_audio.py`). Clean synthetic speech; also record team members reading scripts on a real Meet call for realistic audio.

Prediction rule: a conversation counts as **fraud** if its risk ever reaches `high` (configurable with `--threshold`). Auto-disconnect additionally requires `critical` plus the policy gate.

## Commands

```powershell
backend\.venv\Scripts\python eval\run_text_eval.py --mode rules   # keyword baseline (ablation A)
backend\.venv\Scripts\python eval\run_text_eval.py --mode llm     # contextual LLM detector
backend\.venv\Scripts\python eval\make_tts_audio.py s01_mumbai_police_parcel b01_awareness_discussion
backend\.venv\Scripts\python integration_tests\replay_audio.py eval\audio\s01_mumbai_police_parcel.wav
```

Results are written to `eval/results/` with the config version and timestamp.

Groq free tier is 8k tokens/min per model, so a full LLM run takes several minutes (it waits on 429s).
