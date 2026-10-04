---
name: moth-method
description: How to plan and build software with moth, the issue tracker that keeps tickets as markdown files in the repo. Use whenever a repo has a moth.config.yml or a .moth/ directory, or when asked to file, find, plan, start, or close tickets, pick the next piece of work, or break a project into milestones or features.
metadata:
  moth-version: "0.6.0"
---

# The Moth Method

moth is the plan. Tickets live in `.moth/` as markdown, the CLI enforces their shape, and git is their history. There is no separate plan file, board to keep in sync, or list in your head: if work is real, it is a ticket, and if it is a ticket, moth can answer questions about it.

This is how to work with it. The rules are short because moth already enforces most of the structure; what is left is judgement.

## Start every session the same way

```sh
moth schema --json                       # this repo's statuses, priorities and fields
moth list --status todo --unblocked      # what is ready to start
```

Never guess a status name or a field. Repos rename statuses; `moth schema --json` says what is legal here. Every status belongs to one of six fixed categories (backlog, unstarted, started, completed, canceled, duplicate), and `--category` works in any repo without knowing the names.

## Writing a ticket

A ticket says what is wrong or missing, what to build, and how anyone will know it is done.

```sh
moth new "Sessions expire while the user is typing" --priority high --label auth --body-file - <<'EOF'
Users lose a half-written post when the session expires mid-edit. The token
is refreshed only on navigation, never on input.

**What to build**

- Refresh the token on input, at most once a minute
- Keep the draft in local storage until it is saved

**Done when**

- [ ] A session active for two hours of typing never expires
- [ ] A draft survives an expired session and a reload
EOF
```

- **Title the problem, not the fix.** "Sessions expire while the user is typing", not "Add token refresh". The title is the filename, the commit-message reference and the list row; it has to make sense to someone who has not read the body.
- **Done-when criteria are checks, not hopes.** Each one is something an agent can verify by running, reading or testing. "Works well" is not a criterion.
- **Pipe bodies with `--body-file -`.** Shell quoting mangles markdown; a heredoc does not.
- **One ticket, one outcome.** If the done-when list covers two unrelated outcomes, it is two tickets.

## Structuring work

Three tools, each for one job. Do not use one for another's job.

**Parents group.** A milestone or a feature is a ticket, and its work is filed under it:

```sh
moth new "Browser milestone" --body "A browser the agent can drive, and limits on where it may go."
moth new "Chrome on the VM" --parent "Browser milestone"
moth list --parent "Browser milestone"
moth stats --parent "Browser milestone"     # how far along it is
```

Nesting has no depth limit: milestone, then feature, then task, if the work needs it. The parent's body describes what the group delivers. A parent is done when you close it; moth does not close it for you.

**Blockers order, and only when there is a real dependency.** `--blocked-by` means "cannot start until that is finished". Do not use it to express preference or sequence; that is what priority is for.

```sh
moth new "Domain locks" --parent "Browser milestone" --blocked-by "Chrome on the VM"
moth edit <ticket> --blocked-by <other>
moth edit <ticket> --unblock <other>
```

**Priority decides what comes first among ready tickets.** Within each status, moth lists tickets by priority, then age. Urgent work found in the middle of a plan gets `--priority high` or `urgent` and goes to the top on its own; nothing needs renumbering.

## Finding the next ticket

```sh
moth list --status todo --unblocked
```

The first row is the next ticket. That is the whole algorithm: ready means unstarted with every blocker finished, and order means priority, then age. If the order is wrong, fix the priorities, not the list.

## Working a ticket

1. **Claim it** before writing code, so nobody else starts it: `moth move <ticket> in-progress` (or this repo's started status).
2. **Re-read it** with `moth show <ticket>`. Check it against the code as it is now, not as it was when the ticket was filed. If the ticket is wrong, fix the ticket first: `moth edit <ticket> --body-file -` to rewrite, or `--title` to rename.
3. **Do the work.** One ticket per commit. If you find other work, file it as its own ticket and keep going; do not widen this one.
4. **Record what was built** by appending to the body, never by rewriting it:

   ```sh
   moth edit <ticket> --append-body-file - <<'EOF'
   ## As built

   Refreshes on input through the existing fetch wrapper. Drafts are keyed by
   route, so two open editors do not overwrite each other.
   EOF
   ```

   Tick the done-when boxes that are now true. Say where the build differed from the plan and why: the next reader needs that more than a restatement of the ticket.
5. **Close it in the same commit as the work**: `moth move <ticket> done`. A commit that does the work and a ticket that still says todo disagree, and the ticket is what the next session will believe.

## Keeping the store honest

- **Change tickets through moth, not by editing files.** moth keeps the filename in step with the title, moves `updated_at`, and refuses invalid values. A hand edit does none of that. If you need the file itself, `moth show <ticket> --json` gives its `path`.
- **Run `moth check` before every commit**, ideally in a pre-commit hook and in CI. It finds stale filenames, dangling blockers, duplicate ids, parent cycles, undeclared fields and unknown statuses.
- **`moth check --fix`** repairs what is safe to repair: filenames and duplicate ids. It leaves a blocker that names a missing ticket alone, because that ticket may exist on another branch. If it was deleted, `moth edit <ticket> --unblock <id>`.

## Triage

- **backlog** is for work not yet committed to. **todo** (the unstarted category) is specified and ready to be picked up. Move a ticket from backlog to todo only when its done-when criteria are written.
- **Cancel, do not delete.** `moth move <ticket> canceled` keeps the record that something was decided against. `moth delete <ticket> --yes` is for tickets filed by mistake.
- **Duplicates** move to the duplicate status, with a line in the body naming the ticket that survives.
- **Counting**: `moth stats` gives counts by status; it takes the same filters as `moth list`.

## When moth says no

moth's errors name the fix. An unknown status lists the legal ones; an ambiguous ticket reference lists what it matched; `moth check` findings name the command that repairs them. Read the error before reaching for the file. Every command has `--help` with a worked example, and `moth help` lists them all.
