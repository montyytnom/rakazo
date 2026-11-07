# DRAIN-PROTOCOL (idle recreate)

Gate on live checks, not the clock alone, and not `runs.status = completed`. Completed is not an outcome signal.

## Recreate windows

Routines fire at `:00` / `:30`. Stay out of `:58–:01` and `:28–:31`. Recreate **only** in:

- `:08–:22`
- `:38–:52`

Do not start a recreate in any other minute. `off_boundary` in overlay helpers (`m % 30` in 2–27) is wider than this protocol; this repair uses the narrower windows above.

## Idle signals (all required)

Take two independent samples **30 seconds apart**. Every signal below must be true on **both** samples, then recreate immediately. Do not collapse this list into `runs.status`.

Direct counts (same as production `idle_report` / `runs_busy`, plus the extra gates this protocol always required):

- `runs` in `leased` / `running` / `queued` = 0 (live non-parked, non-terminal). Parked `waiting_input` may remain.
- Unexpired run leases = 0
- `attempts.status = running` in the last two hours = 0
- Unexpired `computer_execution_leases` (`expiresAt` > utc now) = 0
- No unclaimed steering
- Computers under human control (`state='running'` and `controlHolder='user'`) = 0 — no takeover in progress
- Graphile jobs `locked_at is not null` = 0
- Graphile jobs due in the next three minutes with `locked_at is null` and `attempts < max_attempts` = 0 (ignore jobs already at max attempts)
- No unmatched `job.started` without `job.completed` in the last two minutes
- Worker CPU near idle

`runs_busy` overlay helper is the sum of leased/running/queued runs + unexpired computer execution leases + human takeovers. It is **necessary and not sufficient**. The Graphile, attempt, steering, job-event, and CPU checks still apply.

## Recreate rules

- Recreate only the target service, with that service's full live `-f` chain.
- Never `--remove-orphans` or `prune`.
- Never kill a run to force idle.
- Confirm twice (30 s). If either sample fails, abort; nothing changes.
