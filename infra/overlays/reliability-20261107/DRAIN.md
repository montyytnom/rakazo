# Idle drain before worker recreate

Gate on live checks, not the clock. `runs.status = completed` is not an outcome signal.

All of the following must be true on two samples 30 seconds apart, then recreate immediately:

- No live non-parked, non-terminal run, and no unexpired run lease
- No recent `attempts.status = running` from the last two hours
- No Graphile job locked, and none due in the next three minutes (ignore jobs already at max attempts)
- No unexpired computer execution lease, no unclaimed steering
- Worker CPU near idle; no unmatched `job.started` without `job.completed` in the last two minutes
- No computer takeover in progress

Start only after `:00` / `:30` routine windows. Recreate only the worker, full compose chain, no orphan pruning. Parked `waiting_input` runs may remain.
