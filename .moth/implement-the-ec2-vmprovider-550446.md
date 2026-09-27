---
id: "550446"
title: Implement the EC2 VmProvider
status: todo
priority: none
labels:
  - backend
  - m4
  - vm
created_at: 2026-09-27T05:36:32.981Z
updated_at: 2026-09-27T05:36:33.034Z
blocked_by:
  - "2dd479"
  - "b9062e"
---

The second implementation of the `VmProvider` interface from M2 (docs/design.md §8a, §10, §17 VM state machine).

`create`:
- Create an encrypted gp3 **data volume** (~15 GB) in the chosen AZ, tagged with the user and VM id.
- Launch from the launch template in the same AZ, with user data carrying the one-time registration token and the gateway URL.
- Attach the data volume.
- Return the instance and volume ids.

Handle EC2's eventual consistency (describe calls lagging behind create) with proper waiters. Research whether the data volume should be created as part of `RunInstances` with `DeleteOnTermination=false`, or separately. Either way, the volume must **survive instance replacement**.

`destroy` terminates the instance, deletes the data volume, and deletes its snapshots (account deletion requires everything to be gone). `status` maps EC2 states onto ours.

In `winstond`: on EC2, read the registration token and gateway URL from instance user data via **IMDSv2** instead of env vars.

Select the provider by environment. Tests: the provider against a mocked EC2 client (create order, waiters, the volume surviving replace, and destroy removing snapshots), and `winstond`'s IMDSv2 reading.

The real end-to-end check happens in the production cutover ticket.
