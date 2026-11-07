#!/usr/bin/env python3
"""Launcher bind merge, hash checks, dry-run 37, and staging cleanup."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

import candidate_launch

HERE = Path(__file__).resolve().parent

WORKER_REPLACE = [
    "packages/adapters/src/executor.ts",
    "packages/adapters/src/bot-secrets.ts",
    "packages/adapters/src/computer-browser.ts",
    "packages/adapters/src/browser-tools.ts",
    "packages/adapters/src/pi-runtime.ts",
    "packages/adapters/src/history-compaction.ts",
    "packages/adapters/src/bot-messages.ts",
    "packages/adapters/src/pi-openai-compatible-provider.ts",
]
API_REPLACE = [
    "packages/adapters/src/executor.ts",
    "packages/adapters/src/computer-browser.ts",
    "packages/adapters/src/browser-tools.ts",
    "packages/adapters/src/pi-runtime.ts",
    "packages/adapters/src/history-compaction.ts",
    "packages/adapters/src/bot-messages.ts",
    "packages/adapters/src/pi-openai-compatible-provider.ts",
]
OVER_IMAGE = [
    "packages/adapters/src/pi-usage.ts",
    "packages/core/src/index.ts",
]
ABSENT = [
    "packages/core/src/irreversible-effect.ts",
    "packages/core/src/secret-result-handle.ts",
    "packages/core/src/completion-artifact.ts",
    "packages/core/src/compaction-provenance.ts",
    "packages/core/src/handoff-delivery.ts",
    "packages/adapters/src/stale-element-recovery.ts",
    "packages/adapters/src/desktop-tool-contract.ts",
    "packages/adapters/src/protected-result.ts",
    "packages/adapters/src/model-stream-error.ts",
]


def sha_of(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def write_file(path: Path, text: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return sha_of(text)


def make_overlay(root: Path) -> tuple[Path, list[dict[str, str]]]:
    overlay = root / "pack"
    overlay.mkdir()
    rows = ["service\tpath\tdest\taction\tbefore_sha256\tafter_sha256\thost_source"]
    staged_spec = []

    def add(service: str, rel: str, action: str) -> None:
        body = f"{service}:{rel}:{action}\n"
        host = f"files/{service}/after/{rel}"
        digest = write_file(overlay / host, body)
        dest = f"/app/{rel}"
        before = "ABSENT" if "absent" in action else "0" * 64
        if action == "skip-unchanged-image":
            host_col = ""
        else:
            host_col = host
        rows.append(f"{service}\t{rel}\t{dest}\t{action}\t{before}\t{digest}\t{host_col}")
        if action != "skip-unchanged-image":
            staged_spec.append(
                {"service": service, "path": rel, "dest": dest, "action": action, "after": digest}
            )

    for rel in WORKER_REPLACE:
        add("worker", rel, "replace-existing-bind")
    for rel in OVER_IMAGE:
        add("worker", rel, "add-bind-over-image")
    for rel in ABSENT:
        add("worker", rel, "add-bind-absent-path")
    add("worker", "packages/core/src/approval-effect-key.ts", "skip-unchanged-image")
    for rel in API_REPLACE:
        add("api", rel, "replace-existing-bind")
    for rel in OVER_IMAGE:
        add("api", rel, "add-bind-over-image")
    for rel in ABSENT:
        add("api", rel, "add-bind-absent-path")
    add("api", "packages/core/src/approval-effect-key.ts", "skip-unchanged-image")
    add("api", "packages/adapters/src/bot-secrets.ts", "skip-unchanged-image")
    (overlay / "COMPOSE-OVERRIDE.tsv").write_text("\n".join(rows) + "\n")
    return overlay, staged_spec


class CandidateLaunchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.overlay, self.spec = make_overlay(self.root)
        self.stage = self.root / "rakazo-candidate-capture-stage"
        self.out = self.root / "out"
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        (self.bundle / "candidate-capture-harness.ts").write_text("// test harness stub\n")
        (self.bundle / "allowlisted-env.txt").write_text(
            (HERE / "allowlisted-env.txt").read_text()
        )
        (self.bundle / "run.sh").write_text("#!/bin/bash\n")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_compose_override_has_37_candidate_rows(self) -> None:
        rows = candidate_launch.load_compose_override(self.overlay)
        candidate_launch.assert_unique_dests(rows)
        candidate = [row for row in rows if row["action"] in candidate_launch.CANDIDATE_ACTIONS]
        self.assertEqual(len(candidate), 37)

    def test_replace_does_not_duplicate_and_add_binds_are_new(self) -> None:
        rows = candidate_launch.load_compose_override(self.overlay)
        staged = candidate_launch.stage_after_files(
            self.overlay,
            self.stage,
            [row for row in rows if row["action"] in candidate_launch.CANDIDATE_ACTIONS],
        )
        inspected = [
            {
                "source": f"/opt/production/{rel}",
                "destination": f"/app/{rel}",
                "mode": "ro",
            }
            for rel in WORKER_REPLACE
        ] + [
            {
                "source": "/opt/production/login-guard.ts",
                "destination": "/app/packages/adapters/src/login-guard.ts",
                "mode": "ro",
            }
        ]
        mounts, binds, preserved = candidate_launch.merge_mounts(
            "worker", inspected, staged, self.bundle, self.out / "worker"
        )
        dests = [row["destination"] for row in mounts]
        self.assertEqual(len(dests), len(set(dests)))
        executor = next(row for row in binds if row["destination"].endswith("/executor.ts"))
        self.assertEqual(executor["action"], "replace-existing-bind")
        self.assertNotIn("/opt/production/packages/adapters/src/executor.ts", executor["source"])
        self.assertTrue(executor["source"].startswith(str(self.stage)))
        self.assertTrue(
            any(row["destination"].endswith("/pi-usage.ts") for row in binds),
        )
        self.assertTrue(
            any(row["destination"].endswith("/secret-result-handle.ts") for row in binds),
        )
        self.assertTrue(
            any(
                row["destination"] == "/app/packages/adapters/src/login-guard.ts"
                and row["action"] == "preserve-unchanged-mount"
                for row in preserved
            )
        )
        self.assertEqual(len(binds), 19)

    def test_hash_mismatch_refuses(self) -> None:
        rows = candidate_launch.load_compose_override(self.overlay)
        candidate = [row for row in rows if row["action"] in candidate_launch.CANDIDATE_ACTIONS]
        candidate[0]["after_sha256"] = "0" * 64
        with self.assertRaises(SystemExit):
            candidate_launch.stage_after_files(self.overlay, self.stage, candidate)

    def test_duplicate_dest_refuses(self) -> None:
        rows = candidate_launch.load_compose_override(self.overlay)
        rows.append(rows[1])
        with self.assertRaises(SystemExit):
            candidate_launch.assert_unique_dests(rows)

    def test_dry_run_lists_all_37_and_records_hashes(self) -> None:
        env = os.environ.copy()
        os.environ["RAKAZO_WORKER_IMAGE"] = candidate_launch.PINNED_WORKER_IMAGE
        os.environ["RAKAZO_API_IMAGE"] = candidate_launch.PINNED_API_IMAGE
        os.environ.pop("RAKAZO_WORKER_CONTAINER", None)
        os.environ.pop("RAKAZO_API_CONTAINER", None)
        try:
            rc = candidate_launch.main(
                [
                    "--bundle",
                    str(self.bundle),
                    "--candidate-overlay",
                    str(self.overlay),
                    "--stage",
                    str(self.stage),
                    "--out",
                    str(self.out),
                    "--dry-run",
                    "--pack-sha256",
                    "e342a560deadbeef",
                    "--git-head",
                    "b44665b26",
                ]
            )
        finally:
            os.environ.clear()
            os.environ.update(env)
        self.assertEqual(rc, 0)
        manifest = json.loads((self.out / "dry-run-manifest.json").read_text())
        self.assertEqual(manifest["candidateBindCount"], 37)
        self.assertEqual(len(manifest["candidateBinds"]), 37)
        self.assertEqual(manifest["packSha256"], "e342a560deadbeef")
        self.assertEqual(manifest["gitHead"], "b44665b26")
        self.assertTrue(manifest["notBaselineAssembler"])
        tsv = (self.out / "candidate-binds.tsv").read_text().splitlines()
        self.assertEqual(len(tsv) - 1, 37)
        joined = " ".join(manifest["services"][0]["dockerRun"])
        self.assertIn("--pull=never", joined)
        self.assertIn("--network none", joined.replace(" --network ", " --network "))
        self.assertIn("--read-only", joined)
        self.assertIn("--cap-drop", joined)
        self.assertIn("no-new-privileges:true", joined)
        self.assertIn("--pids-limit", joined)
        self.assertNotIn("/run/secrets", joined)
        self.assertNotIn("/data:", joined)

    def test_cleanup_refuses_production_roots(self) -> None:
        with self.assertRaises(SystemExit):
            candidate_launch.cleanup_stage(Path("/opt/docker/rakazo"))
        with self.assertRaises(SystemExit):
            candidate_launch.cleanup_stage(self.root / "not-the-mark")

    def test_cleanup_removes_capture_stage_only(self) -> None:
        self.stage.mkdir()
        (self.stage / "keep-me-not").write_text("x")
        rc = candidate_launch.cleanup_stage(self.stage)
        self.assertEqual(rc, 0)
        self.assertFalse(self.stage.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
