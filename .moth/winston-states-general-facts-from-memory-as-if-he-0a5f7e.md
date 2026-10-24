---
id: "0a5f7e"
title: Winston states general facts from memory as if he checked them
status: in-progress
priority: medium
labels:
  - agents
  - prompts
parent: "07ba81"
created_at: 2026-10-24T16:49:56.868Z
updated_at: 2026-10-24T20:01:02.489Z
---

The grounding rule from ea2e27 ("Go to the best source") is framed around the user's bookings and live facts. General claims skip it, and wrong ones are stated with confidence.

**From the trace audit (07ba81):**

- **Oct 15:** Winston said 30×22.2 in "isn't a standard ready-made size" and suggested matting it into a 22×28 frame. 22×30 in is a standard size, and a 30 in piece can't fit a 22×28 frame.
- **Oct 14:** "Edward" was guessed from a Google AI Overview (Edward Piccinich of SL Green), 10 minutes before the lunch. Winston's own thinking called it "likely hallucinated".
- **Oct 4:** a Wells Fargo address was recalled from memory and typed into an ACH form.
- **Oct 3:** flight WiFi "50–60% likely", from memory.
- **Oct 6:** festival hours "16:30–20:00" invented, and a "preliminary" slot called "Confirmed".
- **Oct 2:** "KTN… unlikely to be asked for since he isn't flying back into the US", for a JFK departure.
- **Oct 13:** a lease was offered for Apple's one-shot proof-of-address upload as a "registration office document". It isn't on Apple's list, and no utility bill or bank statement was looked for.
- **Oct 5:** a draft email in Nik's voice said he'd "read through the first rapporteur report on 'AGI Ruin'", which he never said.

**What to build**

- **Both prompts:** a factual claim that matters to a decision (sizes, addresses, rules, policies, who someone is) is looked up or marked as a guess. AI Overviews and search snippets count as secondhand.
- **Requirements:** when something must meet stated requirements (a document list, a form's rules), check against that list and say plainly when it doesn't match.
- **Drafts in the user's voice** contain only what the user said or what's on record.
- Replay cases from the frame-size, Edward and Apple incidents.

**Done when**

- [ ] Replay: frame sizes answered with a lookup, or both units given with a caveat (3/3)
- [ ] Replay: the Apple proof of address picks a listed document type, or says the lease isn't on the list (3/3)
- [ ] Existing grounding replay cases still pass
- [ ] docs/design.md updated

## Progress (2026-10-24)

- **`front-of-house.md`, "Staying honest":**
  - AI overviews count as secondhand.
  - "Memory is a guess too": a fact the user will act on gets looked up or is said to be from memory, and anything that must meet a stated list is checked against it, saying so when it doesn't match.
  - Anything written in the user's voice says only what they said or what's on record.
- **`background.md`:** the same, in its grounding paragraph.
- **Held-out replay cases:** `fact-frame-size` and `fact-document-requirements`.
- **Left:** run them, the Edward case if exported, and the existing grounding cases. Blocked: the dev OpenRouter key is out of credit. Then record in docs/design.md and close.

## Replays (2026-10-24): improved, not yet passing

- `fact-frame-size`: 0/8 on the old prompt → 0/5 on the first change → **4/13** after "a question about a fact in the world is a lookup… never state from memory that something isn't standard". The misses still answer from memory at `low` effort.
- `fact-document-requirements`: 5/5 (3/3 on the old prompt too).

Left open. Answering general-knowledge questions without a lookup looks like a limit of Sonnet at `low`, more than of the wording.
