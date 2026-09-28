# Reply design: attachments, streamed messages and ending a turn

Research from 2026-09-27/28 behind decision #70 (docs/design.md). Two questions: how Winston should send files from his computer, and how his turn becomes Telegram messages.

## Prior art: how agents send files

| System                   | Mechanism                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw                 | Started with `MEDIA:/path` lines in the reply; its docs now call those legacy in favour of structured media fields on a tool, plus a CLI (`message send --media`) |
| Hermes Agent (Nous)      | `MEDIA:/path` lines in the reply, extracted by the gateway                                                                                                        |
| Claude.ai                | A native `present_files` tool (from a leaked prompt, unofficial)                                                                                                  |
| Manus                    | A message tool with an `attachments` parameter (from leaked tools, unofficial)                                                                                    |
| ChatGPT code interpreter | `sandbox:/mnt/data/…` links in the text, rewritten by the client; often broken outside the web app                                                                |

Reply markup has a long trail of production bugs in OpenClaw and Hermes: directives shown as literal text, files silently dropped, paths with spaces broken, and nothing telling the model a directive failed. No published eval compares the approaches, so we ran our own.

Sources: docs.openclaw.ai (rich-output-protocol, media-and-attachments), hermes-agent.nousresearch.com (Telegram), Anthropic's "Writing tools for agents" and "Building effective agents", Vercel's "We removed 80% of our agent's tools".

## Method

- Sonnet 5 at `low` effort through OpenRouter, pinned to Anthropic, exactly as the front of house runs.
- The real front-of-house prompt, adapted per design (below), and the real `bash` in throwaway containers from `winston-vm:local`, reset to a fixture before each trial: PDFs with real text (a boarding pass, two invoices, reports), photos in `~/inbox/<date>/`, a 60 MB video, notes.
- Mechanical checks per scenario (the right files sent, silence when nothing needs saying, key facts present). For the second eval, also a blind judge (Opus 5.5) that saw only the event, the tool activity and the messages delivered, in the same format for every design, and counted narration, premature claims and duplicates and rated quality 1–5.
- Two harness problems were found and fixed before the final runs: commands passed through `JSON.stringify` broke heredocs, and stub fixtures (one-line "PDFs", an all-zero video) made the model refuse them as fakes.

## Eval 1: how to attach (tool vs CLI vs markup)

Designs: a native `attach(paths)` tool; a `winston reply attach <path>…` CLI command via `bash`; `MEDIA: <path>` lines in the reply. Each got one matching line in the prompt. 12 scenarios × 4 runs (144 trials).

|                  | Tool  | CLI   | Markup |
| ---------------- | ----- | ----- | ------ |
| Pass             | 48/48 | 46/48 | 46/48  |
| Avg input tokens | 6,821 | 6,504 | 5,185  |

- Deciding whether and what to attach was 100% for all three, on positives (send back a photo, several files, make then send a CSV, resize then send) and negatives (answer inline, "thanks", "do I have PDFs?").
- The CLI's two misses weren't about attaching (it refused a sparse placeholder video; it asked before sending one file of two).
- Markup's misses were the finding: it saw the video was 60 MB, still wrote the `MEDIA:` line and replied "Found it." Nothing would have been sent, and nothing tells the model. That happened in about half its oversize trials across runs. A tool or command returns the error during the turn.
- Tool vs CLI couldn't be separated by the data. The user chose the native tool: attaching shapes the current reply, which belongs to the agent loop (like ending the turn), not the CLI, which is Winston's interface to the world.

## Eval 2: final-text replies vs streamed replies

- **Final text** (decision #68): only the last step's text is sent; `attach` is staged and goes out after it; `no_reply` ends the turn and discards text beside it.
- **Streamed:** every step's text is sent in order, before the step's tools run; `attach` sends immediately; `end_turn` ends the turn, sending any text beside it.

16 scenarios (file requests, silence, inline answers, multi-step tasks that invite narration) × 4 runs.

| All 16 scenarios         | Final text | Streamed |
| ------------------------ | ---------- | -------- |
| Pass                     | 58/64      | 63/64    |
| Judge quality (1–5)      | 4.58       | 4.75     |
| Narration messages       | 0          | 0        |
| Premature claims         | 3          | 0        |
| Duplicates               | 0          | 1        |
| Trials with text dropped | 18         | —        |
| Avg input tokens         | 6,975      | 7,499    |

The streamed prompt spells out its rules and the production final-text prompt never says that text beside a tool call is dropped, so a fairness check added that rule to the final-text prompt ("Only your last message, written after your final tool call, is sent…") and re-ran the 11 file and silence scenarios:

| 11 file + silence scenarios        | Pass  | Quality |
| ---------------------------------- | ----- | ------- |
| Final text, production prompt      | 39/44 | 4.48    |
| Final text, plus the explicit rule | 40/44 | 4.61    |
| Streamed                           | 43/44 | 4.75    |

- **Final text fights how the model writes.** It put its real message beside the `attach` call ("Here you go — seat 14C, gate F12…") and it was dropped, even with the explicit rule (13 of 44 trials). Usually harmless ("Found it."), but some left the user with only "Done." or "Attached above." and the requested details missing, and "Sent." twice hid that one of two files didn't exist.
- **Streamed's feared costs didn't appear:** no narration and no premature claims, with prompt lines against both. Its weakness is occasional choppiness (a short reply split around a file) and one near-duplicate.
- Silence ("thanks", "ok cool", 👍) and inline answers were 100% for both.
- **Caveats:** 4 runs per scenario, single-turn, steering not simulated, and the judge is also a Claude model. The direction held across runs and the fairness check; the size of the gap is rough.

## The streamed prompt

The "Replying" section as adopted:

> Everything you write is sent to the user right away as a Telegram message, in the order you write it. Your tool calls happen in between, so the user sees your messages in the order you produce them.
>
> - Only write what the user should read. Don't narrate your work ("Let me check…", "Looking in your inbox…"). Before something that will take many steps, one short heads-up is fine ("On it, give me a minute").
> - Text you write alongside a tool call is sent before that tool runs, so don't say something is done until you've seen it succeed.
> - When you're done, call `end_turn`; your last message can go in the same step. Not everything needs a reply: when nothing needs saying ("thanks", "ok"), call `end_turn` without writing anything.
