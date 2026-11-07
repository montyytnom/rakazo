#!/usr/bin/env python3
"""Checker must fail the 729d vacuous executor rows and pass a completed AFTER row."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import check_nonvacuous

VACUOUS = {
    "ok": True,
    "http": "",
    "persist": "[]",
    "final": '[{"outcome":"failed","error":"Required context exceeds the model context budget"}]',
    "handoff": "null",
    "httpBytes": 0,
    "httpRequestCount": 0,
    "runOutcome": "failed",
    "runError": "Required context exceeds the model context budget",
    "executeToolNames": [],
    "executeArgsHasCurrent": False,
    "stubEmittedDone": False,
    "finalHasDoneWord": False,
    "finalHasNotVerified": False,
}


class CheckNonvacuousTests(unittest.TestCase):
    def test_729d_executor_rows_are_vacuous(self) -> None:
        for name in (
            "generated-secret",
            "stale-secret",
            "protected-handoff-repaired-path",
            "false-success-done",
        ):
            failures = check_nonvacuous.evaluate(name, VACUOUS)
            self.assertIn("VACUOUS_ZERO_HTTP", failures, name)
            self.assertIn("VACUOUS_FAILED_RUN", failures, name)
            self.assertIn("VACUOUS_MISSING_TOOL_ROUND", failures, name)

    def test_raw_http_body_is_privacy_fail(self) -> None:
        failures = check_nonvacuous.evaluate(
            "generated-secret",
            {
                "ok": True,
                "http": '{"messages":[{"content":"operating-name"}]}',
                "httpBytes": 80000,
                "httpRequestCount": 2,
                "persist": '[{"id":"effect-1"}]',
                "final": '[{"outcome":"completed"}]',
                "runOutcome": "completed",
                "executeToolNames": ["scratchpad_add"],
                "executeArgsHasCurrent": True,
            },
        )
        self.assertIn("PRIVACY_RAW_HTTP_PERSISTED", failures)

    def test_false_done_without_nudge_is_vacuous(self) -> None:
        failures = check_nonvacuous.evaluate(
            "false-success-done",
            {
                "ok": True,
                "httpBytes": 80000,
                "httpRequestCount": 2,
                "persist": '[{"id":"effect-1"}]',
                "final": '[{"outcome":"completed","blocks":[{"text":"Outcome was not verified."}]}]',
                "runOutcome": "completed",
                "executeToolNames": ["scratchpad_add"],
                "stubEmittedDone": True,
                "httpHasBareDoneNudge": False,
                "stubEmittedNudgeFiller": False,
                "finalHasNotVerified": True,
                "finalHasDoneWord": False,
                "finalHasUnsupportedDoneShape": False,
            },
        )
        self.assertIn("VACUOUS_MISSING_BARE_DONE_NUDGE", failures)

    def test_compaction_pass_row_is_nonvacuous(self) -> None:
        failures = check_nonvacuous.evaluate(
            "compaction-current-secret",
            {"ok": True, "summary": "New password: [withheld]", "hasCurrent": False, "hasStale": False, "hasAllSet": False},
        )
        self.assertEqual(failures, [])

    def test_execute_layout_out_service_is_discovered(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            passing = {
                "ok": True,
                "httpBytes": 80000,
                "httpRequestCount": 3,
                "persist": '[{"id":"effect-1"}]',
                "final": '[{"outcome":"completed"}]',
                "runOutcome": "completed",
                "executeToolNames": ["scratchpad_add"],
                "executeArgsHasCurrent": True,
                "stubEmittedDone": True,
                "httpHasBareDoneNudge": True,
                "stubEmittedNudgeFiller": True,
                "finalHasNotVerified": True,
                "finalHasDoneWord": False,
                "finalHasUnsupportedDoneShape": False,
                "httpBodiesPersisted": False,
            }
            compaction = {
                "summary": "New password: [withheld]",
                "hasCurrent": False,
                "hasStale": False,
                "hasAllSet": False,
            }
            for service in ("worker", "api"):
                dest = root / service
                dest.mkdir(parents=True)
                scenarios = {
                    "generated-secret": {**passing, "httpRequestCount": 2, "httpHasBareDoneNudge": False, "stubEmittedNudgeFiller": False, "stubEmittedDone": True, "finalHasNotVerified": False},
                    "stale-secret": {**passing, "httpRequestCount": 2, "httpHasBareDoneNudge": False, "stubEmittedNudgeFiller": False},
                    "protected-handoff-repaired-path": {
                        **passing,
                        "httpRequestCount": 2,
                        "httpHasBareDoneNudge": False,
                        "stubEmittedNudgeFiller": False,
                        "executeToolNames": ["scratchpad_add", "protected_result_handoff"],
                        "handoff": '{"ok":true}',
                    },
                    "false-success-done": {**passing, "executeArgsHasCurrent": False},
                    "compaction-current-secret": compaction,
                    "compaction-stale-secret": compaction,
                }
                (dest / "phases-summary.json").write_text(json.dumps({"scenarios": scenarios}) + "\n")
            found = check_nonvacuous.discover_summaries(root)
            self.assertEqual({(s, b) for s, b, _ in found}, {("worker", "execute"), ("api", "execute")})
            report = check_nonvacuous.check_tree(root)
            self.assertTrue(report["ok"], report)

    def test_tree_with_vacuous_executor_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for service in ("worker", "api"):
                for branch in ("ctxmem-facts-on", "ctxmem-facts-off"):
                    dest = root / service / branch
                    dest.mkdir(parents=True)
                    scenarios = {
                        "generated-secret": VACUOUS,
                        "stale-secret": VACUOUS,
                        "protected-handoff-repaired-path": VACUOUS,
                        "false-success-done": VACUOUS,
                        "compaction-current-secret": {
                            "summary": "New password: [withheld]",
                            "hasCurrent": False,
                            "hasStale": False,
                            "hasAllSet": False,
                        },
                        "compaction-stale-secret": {
                            "summary": "Old password: [withheld]",
                            "hasCurrent": False,
                            "hasStale": False,
                            "hasAllSet": False,
                        },
                    }
                    (dest / "phases-summary.json").write_text(
                        json.dumps({"scenarios": scenarios}) + "\n"
                    )
            report = check_nonvacuous.check_tree(root)
            self.assertFalse(report["ok"])
            self.assertGreater(report["failed"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
