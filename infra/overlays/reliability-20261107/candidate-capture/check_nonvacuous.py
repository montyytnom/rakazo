#!/usr/bin/env python3
"""Fail-closed non-vacuous checker for candidate-capture phase files.

no-throw / ok=true / rc=0 is not proof. Executor scenarios must show nonempty
raw HTTP, at least two stub rounds, a completed run, the expected tool (and
handoff), persist/final reached, the sentinel in tool args before withhold,
and AFTER withhold on http/persist/final/handoff. false-success-done must have
been emitted as Done by the stub, then rewritten. If a local row still has a
raw `http` body, consume it for sha256/flags and omit the body from metrics.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

EXECUTOR = {
    "generated-secret",
    "stale-secret",
    "protected-handoff-repaired-path",
    "false-success-done",
}
COMPACTION = {"compaction-current-secret", "compaction-stale-secret"}
REQUIRED = EXECUTOR | COMPACTION
MIN_HTTP_REQUESTS = 2
ASSIST_BARE_DONE_NUDGE = (
    "Give the user the actual result now: what you did, what you found or changed, "
    "and how you checked it. A bare 'done' is not enough."
)
CURRENT_SECRET_SENTINEL = "Cur#Rpr7xQ2mN9kL"
STALE_SECRET_SENTINEL = "Old#Stl4pW8vB3yH"


def consume_http_body(row: dict) -> dict:
    """Read raw HTTP locally for hashes/flags. Never copy the body into metrics."""
    out = {key: value for key, value in row.items() if key != "http"}
    http = row.get("http")
    if not isinstance(http, str) or not http:
        return out
    encoded = http.encode("utf-8")
    out["httpBytes"] = out.get("httpBytes") or len(encoded)
    out["httpSha256"] = hashlib.sha256(encoded).hexdigest()
    out["httpHasCurrent"] = CURRENT_SECRET_SENTINEL in http
    out["httpHasStale"] = STALE_SECRET_SENTINEL in http
    out["httpHasBareDoneNudge"] = ASSIST_BARE_DONE_NUDGE in http
    out["httpBodiesConsumed"] = True
    return out


def evaluate(name: str, row: dict) -> list[str]:
    row = consume_http_body(row)
    failures: list[str] = []
    fail = failures.append
    if name in COMPACTION:
        if not (row.get("summary") or ""):
            fail("VACUOUS_EMPTY_COMPACTION_SUMMARY")
        if row.get("hasCurrent") is True:
            fail("AFTER_LEAK_CURRENT_IN_COMPACTION")
        if row.get("hasStale") is True:
            fail("AFTER_LEAK_STALE_IN_COMPACTION")
        if row.get("hasAllSet") is True:
            fail("AFTER_FALSE_ALL_SET_NOT_REMOVED")
        return failures
    if name not in EXECUTOR:
        return ["UNKNOWN_SCENARIO"]
    http_bytes = int(row.get("httpBytes") or 0)
    http_n = int(row.get("httpRequestCount") or 0)
    outcome = row.get("runOutcome") or ""
    error = str(row.get("runError") or "")
    persist = row.get("persist") if isinstance(row.get("persist"), str) else ""
    final = row.get("final") if isinstance(row.get("final"), str) else ""
    handoff = row.get("handoff") if isinstance(row.get("handoff"), str) else ""
    tools = [str(x) for x in (row.get("executeToolNames") or [])]
    if http_bytes <= 0:
        fail("VACUOUS_ZERO_HTTP")
    if http_n < MIN_HTTP_REQUESTS:
        fail("VACUOUS_MISSING_TOOL_ROUND")
    if outcome != "completed":
        fail("VACUOUS_FAILED_RUN")
    if "context budget" in error.lower() or "context budget" in final.lower():
        fail("VACUOUS_CONTEXT_BUDGET")
    if not final or final == "[]":
        fail("VACUOUS_FINAL_NOT_REACHED")
    if not persist or persist == "[]":
        fail("VACUOUS_PERSIST_NOT_REACHED")
    if "scratchpad_add" not in tools:
        fail("VACUOUS_MISSING_EXPECTED_TOOL_CALL")
    if row.get("httpHasCurrent") is True:
        fail("AFTER_LEAK_CURRENT_IN_HTTP")
    if row.get("httpHasStale") is True:
        fail("AFTER_LEAK_STALE_IN_HTTP")
    if row.get("persistHasCurrent") is True:
        fail("AFTER_LEAK_CURRENT_IN_PERSIST")
    if row.get("persistHasStale") is True:
        fail("AFTER_LEAK_STALE_IN_PERSIST")
    if row.get("finalHasCurrent") is True:
        fail("AFTER_LEAK_CURRENT_IN_FINAL")
    if row.get("finalHasStale") is True:
        fail("AFTER_LEAK_STALE_IN_FINAL")
    if row.get("handoffHasCurrent") is True:
        fail("AFTER_LEAK_CURRENT_IN_HANDOFF")
    if row.get("handoffHasStale") is True:
        fail("AFTER_LEAK_STALE_IN_HANDOFF")
    if name != "false-success-done" and row.get("executeArgsHasCurrent") is not True:
        fail("VACUOUS_SENTINEL_DID_NOT_REACH_TOOL_ARGS")
    if row.get("toolResultAfterHasCurrent") is True:
        fail("AFTER_LEAK_CURRENT_IN_TOOL_RESULT")
    if row.get("toolResultAfterHasStale") is True:
        fail("AFTER_LEAK_STALE_IN_TOOL_RESULT")
    if name == "protected-handoff-repaired-path":
        if "protected_result_handoff" not in tools:
            fail("VACUOUS_MISSING_EXPECTED_HANDOFF")
        if handoff in ("", "null", "undefined"):
            fail("VACUOUS_HANDOFF_NULL")
    if name == "false-success-done":
        if row.get("stubEmittedDone") is not True:
            fail("VACUOUS_STUB_DID_NOT_EMIT_DONE")
        if row.get("httpHasBareDoneNudge") is not True:
            fail("VACUOUS_MISSING_BARE_DONE_NUDGE")
        if http_n < 3:
            fail("VACUOUS_MISSING_NUDGE_TURN")
        if row.get("stubEmittedNudgeFiller") is not True:
            fail("VACUOUS_NUDGE_FILLER_NOT_SCRIPTED")
        if row.get("finalHasNotVerified") is not True:
            fail("AFTER_DONE_NOT_REWRITTEN")
        if row.get("finalHasDoneWord") is True or row.get("finalHasUnsupportedDoneShape") is True:
            fail("AFTER_DONE_STILL_IN_FINAL")
    return failures


def metrics_row(service: str, branch: str, name: str, row: dict, failures: list[str]) -> dict:
    return {
        "service": service,
        "branch": branch,
        "scenario": name,
        "ok": row.get("ok"),
        "nonvacuous": len(failures) == 0,
        "vacuous": len(failures) > 0,
        "failures": failures,
        "httpBytes": row.get("httpBytes"),
        "httpRequestCount": row.get("httpRequestCount"),
        "httpByteCounts": row.get("httpByteCounts"),
        "runOutcome": row.get("runOutcome"),
        "runError": row.get("runError"),
        "persistEffectCount": row.get("persistEffectCount"),
        "finalCount": row.get("finalCount"),
        "executeToolNames": row.get("executeToolNames"),
        "executeArgsHasCurrent": row.get("executeArgsHasCurrent"),
        "stubEmittedDone": row.get("stubEmittedDone"),
        "stubEmittedNudgeFiller": row.get("stubEmittedNudgeFiller"),
        "httpHasBareDoneNudge": row.get("httpHasBareDoneNudge"),
        "httpHasCurrent": row.get("httpHasCurrent"),
        "httpHasStale": row.get("httpHasStale"),
        "stubEmittedFinal": row.get("stubEmittedFinal"),
        "finalHasNotVerified": row.get("finalHasNotVerified"),
        "httpSha256": row.get("httpSha256"),
        "httpBodiesConsumed": row.get("httpBodiesConsumed"),
        "httpBodiesPersisted": False,
        "summary": (row.get("summary") or "")[:80] if name.startswith("compaction-") else None,
    }


def discover_summaries(root: Path) -> list[tuple[str, str, Path]]:
    """Launcher writes OUT/service/phases-summary.json. Smoke writes OUT/service/branch/."""
    found: list[tuple[str, str, Path]] = []
    for path in sorted(root.rglob("phases-summary.json")):
        rel = path.relative_to(root)
        parts = rel.parts
        if len(parts) < 2:
            continue
        service = parts[0]
        if service not in ("worker", "api"):
            continue
        branch = parts[1] if len(parts) > 2 else "execute"
        found.append((service, branch, path))
    return found


def check_tree(root: Path) -> dict:
    rows = []
    failed = 0
    missing = 0
    summaries = discover_summaries(root)
    if not summaries:
        missing = 1
        failed = 1
        rows.append(
            {
                "service": "*",
                "branch": "*",
                "scenario": "*",
                "nonvacuous": False,
                "vacuous": True,
                "failures": ["MISSING_PHASES_SUMMARY"],
            }
        )
    for service, branch, summary_path in summaries:
        summary = json.loads(summary_path.read_text())
        scenarios = summary.get("scenarios") or {}
        for name in sorted(REQUIRED):
            row = consume_http_body(scenarios.get(name) or {})
            failures = evaluate(name, row)
            if name not in scenarios:
                failures = ["MISSING_SCENARIO", *failures]
            metric = metrics_row(service, branch, name, row, failures)
            if "http" in metric:
                metric["failures"] = [*(metric.get("failures") or []), "PRIVACY_RAW_HTTP_IN_METRICS"]
                metric["nonvacuous"] = False
                metric["vacuous"] = True
                failures = metric["failures"]
            if failures:
                failed += 1
            rows.append(metric)
    report = {
        "ok": failed == 0,
        "failed": failed,
        "missingTrees": missing,
        "premise": "no-throw/ok/rc0 is not proof the model boundary ran",
        "syntheticWindow": {
            "maxTokens": 32768,
            "contextWindow": 131072,
            "note": "4*32768 previously accepted for isolated-capture; not a live encrypted limit",
        },
        "rows": rows,
    }
    return report


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: check-nonvacuous.py SMOKE_OUT_DIR", file=sys.stderr)
        return 2
    root = Path(argv[1])
    report = check_tree(root)
    out = root / "nonvacuous-metrics.json"
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(out)
    print(f"nonvacuous ok={report['ok']} failed={report['failed']}")
    for row in report["rows"]:
        mark = "PASS" if row["nonvacuous"] else "FAIL"
        print(
            f"{mark} {row['service']} {row['branch']} {row['scenario']} "
            f"httpBytes={row.get('httpBytes')} requests={row.get('httpRequestCount')} "
            f"outcome={row.get('runOutcome')} failures={row.get('failures')}"
        )
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
