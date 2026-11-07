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

    def test_compaction_pass_row_is_nonvacuous(self) -> None:
        failures = check_nonvacuous.evaluate(
            "compaction-current-secret",
            {"ok": True, "summary": "New password: [withheld]", "hasCurrent": False, "hasStale": False, "hasAllSet": False},
        )
        self.assertEqual(failures, [])

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
