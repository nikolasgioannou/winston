---
id: "a54032"
title: Winston gets time zones wrong around travel
status: in-progress
priority: high
labels:
  - agents
  - prompts
parent: "07ba81"
created_at: 2026-10-24T16:49:56.540Z
updated_at: 2026-10-24T20:01:02.286Z
---

The ISO 8601 fix (e19be9) covers times passed to the CLI. It doesn't cover which zone a time belongs to, conversions Winston does in his head, or where the user will be when something happens.

**From the trace audit (07ba81):**

- **Oct 3, 17:07:** Winston gave the Cyprus arrival as "10:55am EDT (12:55pm Cyprus time)". The right time is 17:55. Nik: "How is 10:55 edt 12:55 Cyprus time".
- **Oct 4:** Winston stayed on New York time for about 5 hours after Nik landed in Cyprus. "I'll ping you at 4:07pm" came when it was 21:07 for him. The zone changed only when the site was opened.
- **Oct 5, 21:58:** a NYC movie ticket (Regal Battery Park, Fri Oct 16, 9:10pm) went in as `--start 2026-10-16T21:10` in Asia/Nicosia, 7 hours off, and Winston confirmed it as "9:10–11:10pm".
- **Oct 5, 17:53:** "lets do for 11" was read as 11 Central, so Marc got a wrong-time invite and then an update. Nik: "bro thats 12 isnt it".
- **Oct 12, 09:08:** a Nov 1 reminder was set for 9am Cyprus time, though Nik would be home in NYC by then ("9 am est?"). Winston then switched the profile to New York a day before Nik flew.
- **Oct 13:** Winston suggested a seat change on BA639 while it was in the air. He gave Heathrow gate times without saying that boarding had already started.

**The zone already has a tool:** `winston me update --timezone <IANA>` (`PATCH /v1/me` → `updateProfile`, docs/design.md §20, decision cca55d). Cron triggers follow the zone, and the site's browser detection still overrides it. Today the prompt lets Winston use it only "when they tell you they're somewhere else". This ticket lets him use it from the itinerary too, as the founder asked (2026-10-24).

**What to build**

- **The zone follows the itinerary.** When Winston learns of a trip (a flight on the calendar or a booking in mail), he sets a one-off trigger at the arrival time of each leg that changes the zone. The trigger runs `winston me update --timezone`, then tells the user in a line in the new local time. He says, when he sets it up, that he'll do this. A trip home gets its own trigger back. Check that a background (trigger) run can call `me update`; if it can't, allow it.
- **Scheduling for later uses where the user will be then.** A reminder or event weeks out is set in the zone the user will be in at that time (from notes and the calendar). If unsure, ask.
- **An event happening somewhere else is in that place's zone.** It gets that place's offset (the prompt already says so). `winston calendar create`/`update` warns when the event's location is clearly in a different zone from the user's.
- **Every confirmation of a time names its zone**, and gives the user's own local time too when the two differ ("9:10pm ET, 4:10am your time").
- **Conversions use a tool, not mental arithmetic.** Prompt: work out another zone's time with a command (e.g. `TZ=Asia/Nicosia date -d …`, or a small `winston` helper if that's cleaner), and start from the time now when the answer depends on it ("boarding started 13 minutes ago").
- docs/design.md §20 and decision 55 updated: Winston may change the zone from the itinerary as well as when told.

**Done when**

- [ ] Replay: a flight booking on the calendar leads Winston to set arrival triggers that change the zone, and to say so (3/3)
- [ ] A trigger run at landing changes the zone with `winston me update` and tells the user in the new local time
- [ ] Replay of the Oct 5 movie ticket: the event is created at 21:10 −04:00 and confirmed with its zone (3/3)
- [ ] Replay of the Oct 12 Bella reminder: set in ET, or Winston asks (3/3)
- [ ] `calendar create` warns when a location's zone differs from the user's (test)
- [ ] docs/design.md updated

## As built (2026-10-24)

- **Front-of-house prompt ("Mail and calendar"):**
  - Something happening somewhere else takes that place's offset.
  - **Say the zone:** name it in every time confirmed or given, add the user's own time when the two differ, and convert with a command (`TZ=… date -d …`), never in his head.
  - **Their zone follows them:** the zone is the one setting he changes, and he says so when he does. When he learns of a trip, he sets a one-off trigger at each landing that switches the zone and tells the user in local time, and he says so when he sets it up. Anything set for later goes in the zone the user will be in then.
- **`PATCH /v1/me`** already took any run's token. A test now shows a background run (a landing trigger's run) changing the zone.
- **`winston calendar create`:** with a `--location` and a local `--start` (no offset), it adds a line naming the zone the time was read in and how to give the place's own offset (`zoneNote`). This replaces the planned "warn when the location's zone differs". That would need a geocoder to know where a free-text location is, so the CLI instead says which zone it used whenever a place is given.
- **docs/design.md:** §20 (time zone follows the itinerary), decision 55, and the calendar CLI line.
- **Held-out replay cases:** `tz-event-elsewhere`, `tz-reminder-after-trip` and `tz-trip-landing-trigger`. Not run: the dev OpenRouter key is out of credit.

- [ ] Replay: a flight booking leads to landing triggers that change the zone (`tz-trip-landing-trigger`): waiting on credit
- [x] A trigger run at landing can change the zone with `winston me update` (`index.test.ts`)
- [ ] Replay of the movie ticket (`tz-event-elsewhere`, plus the production call when exported): waiting on credit
- [ ] Replay of the Bella reminder (`tz-reminder-after-trip`): waiting on credit
- [x] `calendar create` says which zone a local time at a place was read in (`calendar.test.ts`; changed from "warns when the zones differ", see above)
- [x] docs/design.md updated

## Replays (2026-10-24): mostly passing

- `tz-trip-landing-trigger`: 0/3 on the old prompt → 0/5 on the first change → **5/5** once the prompt named the moment ("whenever you add a flight… or read a booking… in the same turn").
- `tz-event-elsewhere`: 5/5 (3/3 on the old prompt too).
- `tz-reminder-after-trip`: 0/3 on the old prompt → **9/13** across three rounds. Better, not yet reliable: the misses set `--at` with no offset and don't mention the zone.

Left open for the reminder case.
