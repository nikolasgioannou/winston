---
id: "f2ce33"
title: Restore a user's VM from a snapshot
status: done
priority: none
labels:
  - infra
  - m4
  - vm
created_at: 2026-09-27T05:36:33.484Z
updated_at: 2026-10-01T15:58:15.340Z
blocked_by:
  - "550446"
  - "b9062e"
---

Nightly snapshots are only useful if restoring works (docs/design.md §10, Backups). A dead VM should come back onto a fresh instance from its latest data-volume snapshot, with notes, files, site skills and the Chrome profile intact.

Build a `restore_vm` job (and a `bun run prod vm:restore <user>` entry point) that:
1. Finds the latest snapshot of the user's data volume.
2. Creates a new volume from it.
3. Launches a new instance via the EC2 provider with that volume.
4. Re-registers `winstond` with a fresh registration token (the old VM token is revoked).
5. Terminates the old instance if it still exists.

The VM goes through the normal state machine.

Also document when to use this versus letting EC2 auto-recovery handle it, in `docs/runbooks/vm-recovery.md`. Include how to migrate a VM to a new AMI, which is the same mechanism: new instance, existing data volume (§10).

Test the job's orchestration against mocked EC2. The real exercise happens once in production, restoring the founder's VM deliberately after cutover. Note the date when that's done.

**Done (2026-10-01):** built and tested against a fake EC2 and the database; the deliberate production restore of the founder's VM waits for go-live (docs/runbooks/vm-recovery.md has a line to record it).
