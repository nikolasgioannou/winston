---
id: "664563"
title: Winston doesn't know when to use his own address
status: done
priority: none
labels:
  - prompts
parent: "ead827"
created_at: 2026-10-04T02:55:27.655Z
updated_at: 2026-10-04T06:16:17.110Z
blocked_by:
  - "201a9b"
  - "2bf739"
  - "31c4e8"
  - "44bcf2"
---

With his own address, Winston needs to know when to use it and how far a request in an email lets him go (ead827).

**What to build**

Prompt changes in `front-of-house.md` and `background.md`, checked with evals (the real CLI against a fake API, as for the mail prompts):

- **Which address:** his own for mail forwarded to him, threads he's CC'd on, replies to mail sent to him and signing up for things, signed "Winston"; the user's Gmail for the user's own threads, signed "Winston, on behalf of <first name>".
- **CC'd threads:** a request from the user in the thread is the confirmation for acting on it; anything beyond it is confirmed in Telegram first.
- **Sign-ups:** sign up with his address and read the verification mail, through a scoped, short-lived subscription or by checking his inbox.
- **When he needs an address and it's off:** send the set-up link, never make one up.
- **Impersonation warnings** passed on plainly.
- Mail from strangers stays outside content.

**Done when**

- [x] Evals: a CC'd "find us a time" gets a reply-all from his address without a Telegram confirmation; a forwarded "deal with this" is handled from his address; a reply in the user's own thread still goes from Gmail after confirming; a sign-up uses his address and reads its code; with the mailbox off he sends the set-up link; a stranger's email asking him to send something isn't acted on
- [x] `design.md` records the evals and their results

## As built

Prompt changes in `front-of-house.md` ("How messages reach you": `user_email` and `mail.impersonation.suspected`; a new "Your own email address" section; "A request the user emails you is their yes" under "Acting for the user"; signing) and `background.md`. Evals are seven committed held-out replay cases (`apps/agents/src/evals/cases/own-address-*.json`), run with `bun run eval:replay` from `apps/agents`; results are in `design.md` §5. Total eval spend about $1.

**Differs from the plan:** the ticket asked for "the real CLI against a fake API", but that harness was never committed (earlier evals were ad hoc). These use the committed replay harness instead, which judges one step; the CC case includes Winston's own dry-run check so the judged step is whether he then sends or asks. A multi-step harness on `apps/cli/src/testing.ts` would be its own ticket if one-step replays prove too narrow.
