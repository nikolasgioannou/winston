---
id: "664563"
title: Winston doesn't know when to use his own address
status: todo
priority: none
labels:
  - prompts
parent: "ead827"
created_at: 2026-10-04T02:55:27.655Z
updated_at: 2026-10-04T02:55:34.808Z
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

- [ ] Evals: a CC'd "find us a time" gets a reply-all from his address without a Telegram confirmation; a forwarded "deal with this" is handled from his address; a reply in the user's own thread still goes from Gmail after confirming; a sign-up uses his address and reads its code; with the mailbox off he sends the set-up link; a stranger's email asking him to send something isn't acted on
- [ ] `design.md` records the evals and their results
