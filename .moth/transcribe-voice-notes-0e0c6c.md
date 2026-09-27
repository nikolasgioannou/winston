---
id: "0e0c6c"
title: Transcribe voice notes
status: todo
priority: none
labels:
  - agents
  - m2
  - telegram
created_at: 2026-09-27T05:32:52.082Z
updated_at: 2026-09-27T05:32:52.130Z
blocked_by:
  - "0bfb79"
  - "ca5d9c"
---

Voice notes are transcribed and then treated exactly like typed text, marked as coming from voice (product.md §2, docs/design.md §4 Media).

Research OpenRouter's `/api/v1/audio/transcriptions` endpoint (launched July 2026): request format, supported audio formats (Telegram voice notes are OGG/Opus, so check whether conversion is needed), models (default GPT-4o Mini Transcribe, with Whisper and Voxtral alternatives), pricing and limits.

Flow:
- A `voice` update creates the item with the audio saved to the VM inbox like any attachment, plus a `transcribe_voice` job.
- The job transcribes it and fills in the item's text with `source: voice`, then queues the front-of-house turn.
- Record the cost in `cost_ledger` with category `stt`.
- **On failure:** Winston replies with a fixed message ("I couldn't make out that voice note, can you type it?"). The audio stays on the VM.

Also handle `video_note` (round videos) the same way if the audio can be extracted cheaply. Otherwise treat it as a regular attachment.

Tests with a fake transcription client: the transcript lands in the envelope with the voice marker, the turn waits for transcription, and failure sends the fixed message and still stores the file.
