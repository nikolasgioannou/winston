---
id: "feebd3"
title: Make Winston less chatty while he works
status: done
priority: none
labels:
  - agents
  - telegram
created_at: 2026-10-03T17:26:02.942Z
updated_at: 2026-10-03T19:07:17.582Z
---

From the production trace review (5c3cdf, 2026-10-03); the founder agreed: "it was doing too much".

**What happened:** 19 of 84 front-of-house turns sent two or more messages, and those turns produced 46 of the 107 messages. The patterns:
- **Narrating browser work:** "No overlay visible now, just a loading hiccup earlier. Trying the click again." then "It's a web component quirk, not a real overlay. Using pixel click from the screenshot coordinates." then "Good, that worked — moving to the passport/APIS details form now." in one turn, six messages in all.
- **One message per item:** "OpenTable: loads normally." "Ticketmaster: bot-check…" "Reddit: blocked…" sent separately, then a summary repeating all of them.
- **Heads-up plus result:** "Got it — noted for next time: …" then "Saved that as a standing rule…"; "Permissions are on. Running it now." then the result; "Found it — different thread. Pulling it." then the answer.

**Why the prompt alone hasn't fixed it:** the front-of-house prompt already says "Don't narrate your work", but any text written alongside a tool call is sent the moment that step's model call ends (decision #70). The model keeps writing status, and every status becomes a permanent message.

## Proposal: status is ephemeral, answers are messages

- **Text that becomes a status:** text written alongside a tool call other than `end_turn` (an interim step) is shown as a Telegram **draft**, not sent as a message. `sendMessageDraft` (Bot API 10.3, private chats) shows a temporary preview: updates with the same `draft_id` animate in place, it vanishes when the bot sends a real message, and it fades after about 30 s. So the founder sees "Checking your calendar…" live, replaced by the next status, then by the answer.
- **What stays a message:** the turn's final text (the step that ends the turn, with or without `end_turn`), the handoff link message, and `attach`.
- **Never silent:** if the turn ends with no final text, the last status is sent as a real message, so the founder is never left with nothing.
- **Prompt (principle-level):** "text you write while you're still working shows only as a passing status; put everything the user needs in your final message". One line in "Replying".
- **Fallback:** if a draft can't be sent (an API error), drop the status and log it rather than send it as a message.
- **Typing indicator:** keep it for silent stretches; a draft replaces it while shown.

## Interplay with earlier decisions

- **#70 (streamed replies):** still holds for the *final* text; interim text changes from a message to a status. That's a decision-log update.
- **#72 (no streamed drafts):** still holds. That rejected streaming *tokens* into drafts because a refused output, sometimes cut mid-stream, must never be shown. Here only completed steps that didn't end in a refusal (`finishReason` `stop` or `tool-calls`) become drafts, the same text #70 already sends. So the refusal concern doesn't apply.
- **Steering (#14):** a step dropped for new input sends nothing today; it should also show no status, or clear one already shown.

## Check before building

- Verify `sendMessageDraft` on the founder's phone and desktop: how a draft looks, how it's replaced, what a 30-second fade looks like during a long browser flow (re-send to keep it alive?), and whether it works with the bot's rich messages (`sendRichMessageDraft` exists).
- grammY 1.46 doesn't type the draft methods; call them raw, as `sendRichMessage` already is (`apps/agents/src/telegram/sender.ts`).

Docs: §4 (Replying, typing indicator), decisions #70 and #72, docs/research/telegram-rich-messages.md.

Tests: an interim step's text goes to a draft, not a message; the final text is a message; a turn ending silently after a status sends that status; a dropped step shows no status; draft failure drops the status and logs it; handoff and attach messages are unaffected.

## As built

- **Status or message.**
  - **Status:** text beside a tool that does work (`bash`, `view_image`) goes to `sendRichMessageDraft`, one random `draft_id` per turn, so each status replaces the last in place.
  - **Message:** text with no tool call, or beside `end_turn`, `browser_handoff`, `delegate` or `attach`, is a message as before.
  - **Why those count as messages:** the handoff link and the file must come after their words, and text beside `delegate` tells the user the work moved to the background. The step-budget handover in particular has to reach them.
- **Never silent:** a turn that showed a status but sent no message sends its last status when it ends silently, emptily, or by delegating on its last step. The server's own handover at the step budget already says so in its own message.
- **Failures and drops:**
  - A draft Telegram refuses is logged and dropped.
  - A step dropped for new input shows nothing and forgets the pending status. Rich drafts document no "clear", so an earlier status just gets replaced or fades.
- **Unchanged:** the typing indicator. #72 still holds: only whole steps that ended in `stop` or `tool-calls` become drafts.
- **Prompt:** "Replying" now says how it works: text while working shows only as a passing status, so put what the user needs in a message. The old "don't narrate" line is gone.
- **Not yet checked on a phone:**
  - how the 30-second fade looks during a long browser step;
  - whether a rich draft renders like the messages.

  The founder can see it after the deploy, and keep-alive re-sends can follow if the fade is a problem.

Tests: interim text becomes drafts (one id, shown before the tool runs) and the final text is the only message; a status-only turn sends its status; a refused draft is dropped; a dropped step shows nothing; messages next to `delegate`, files and handoffs keep their order.

Docs: §4 (live-editing, Processing without responding), §16 delivery, decisions #70 and #75 (new), docs/research/telegram-rich-messages.md.
