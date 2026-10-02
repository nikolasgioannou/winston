# VM recovery

Each user's computer is one EC2 instance plus a separate data volume at `/home/winston` (notes, files, inbox, site skills, the Chrome profile). The instance is disposable; the volume is what matters, and Data Lifecycle Manager snapshots it every night at 07:00 UTC, keeping 14 (docs/design.md §10).

## Which tool for which problem

| Situation                                                            | What to do                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The underlying hardware failed (the instance's status check fails)   | Nothing. EC2's simplified automatic recovery moves the instance to healthy hardware with the same volumes, and `winstond` reconnects.                                                                                                                                                                                                                                            |
| The instance is wedged or its OS is broken, but the data is fine     | **Replace** it: a new instance on the same volume (`provision_vm` with `{ replace: true }`, §17). A VM that turned `failed` gets it from the site's retry button. One that's still `ready` on the current image has no one-command replace yet (`vm:roll` skips a current VM): reboot the instance (EC2 console or `aws ec2 reboot-instances`), and only if that fails, restore. |
| The data volume is lost or damaged, or the user wants yesterday back | **Restore** from the latest snapshot (below). Anything written since that snapshot is lost.                                                                                                                                                                                                                                                                                      |
| A new AMI should reach an existing VM (OS upgrade, image changes)    | Nothing, usually: agents rolls each VM onto the AMI in `/winston/vm-ami` in its user's quiet hours (3–5 am, when nothing's running and no handoff is live), on the same volume. Now: `bun run prod vm:roll <email>` (skipped if it's current or busy). Small updates don't need either; they arrive in place (self-update and unattended upgrades).                              |

## Restoring from a snapshot

```sh
bun run prod vm:restore someone@example.com   # asks for confirmation
```

This queues a `restore_vm` job, which `agents` runs (`restoreVm` in `apps/agents/src/vm/provision.ts`):

1. Finds the user's newest **completed** snapshot (tagged `winston:role=data` and `winston:user=<id>`), and creates a new encrypted gp3 volume from it, tagged the same way.
2. Points the VM at the new volume and replaces the instance through the normal state machine: the old instance is terminated, its VM token dropped, a fresh registration token issued, and a new instance launched with the restored volume attached.
3. Deletes the old volume once it's free. Its snapshots stay until the 14-day retention expires them. `vm:restore` always takes the newest snapshot; going back further is a manual job (create a volume from the older snapshot in the EC2 console, then point the VM at it), not a command.

It only starts from a `ready`, `unhealthy` or `failed` VM, so it never pulls a volume out from under a VM that's still being set up. It runs once (no automatic retries); if it fails, read the `agents` logs before trying again.

**Watching it:** `bun run prod sql "select state, instance_id, data_volume_id from vms where user_id = '<id>'"` goes `registering` and then `ready` once `winstond` on the new instance connects.

## Account deletion

Deleting an account removes the instance, the current data volume, and every snapshot tagged with the user, including those of volumes a restore replaced (§13).

## Status

Go-live has happened (2026-09-30), but no deliberate restore drill has been run in production yet. Do one on the founder's VM at a quiet time (it loses anything written since the night's snapshot) and record the date here.
