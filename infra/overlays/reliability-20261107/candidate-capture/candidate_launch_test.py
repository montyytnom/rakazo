#!/usr/bin/env python3
"""Launcher bind merge, hash checks, dry-run 37, and staging cleanup."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
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

    def fake_live(self, service: str) -> dict:
        rels = WORKER_REPLACE if service == "worker" else API_REPLACE
        extra = (
            "/app/packages/adapters/src/login-guard.ts"
            if service == "worker"
            else "/app/packages/adapters/src/page-browser-session.ts"
        )
        mounts = [
            {
                "source": f"/opt/production/{rel}",
                "destination": f"/app/{rel}",
                "mode": "ro",
            }
            for rel in rels
        ] + [{"source": "/opt/production/extra.ts", "destination": extra, "mode": "ro"}]
        name = (
            candidate_launch.AUTHORED_WORKER_CONTAINER
            if service == "worker"
            else candidate_launch.AUTHORED_API_CONTAINER
        )
        return {
            "name": name,
            "sourceMounts": mounts,
            "skippedMounts": [],
            "forwardedEnv": {},
            "envPrivacy": {"observed": []},
        }

    def run_main(self, *, execute: bool = False, **env: str) -> int:
        previous = os.environ.copy()
        os.environ["RAKAZO_WORKER_IMAGE"] = candidate_launch.PINNED_WORKER_IMAGE
        os.environ["RAKAZO_API_IMAGE"] = candidate_launch.PINNED_API_IMAGE
        os.environ["RAKAZO_WORKER_CONTAINER"] = env.get(
            "RAKAZO_WORKER_CONTAINER", candidate_launch.AUTHORED_WORKER_CONTAINER
        )
        os.environ["RAKAZO_API_CONTAINER"] = env.get(
            "RAKAZO_API_CONTAINER", candidate_launch.AUTHORED_API_CONTAINER
        )
        for key, value in env.items():
            if value == "":
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        argv = [
            "--bundle",
            str(self.bundle),
            "--candidate-overlay",
            str(self.overlay),
            "--stage",
            str(self.stage),
            "--out",
            str(self.out),
            "--pack-sha256",
            "e342a560deadbeef",
            "--git-head",
            "b44665b26",
        ]
        argv.append("--execute" if execute else "--dry-run")
        try:
            return candidate_launch.main(argv)
        finally:
            os.environ.clear()
            os.environ.update(previous)

    def test_dry_run_lists_all_37_when_inspect_matches(self) -> None:
        lives = {"worker": self.fake_live("worker"), "api": self.fake_live("api")}

        def fake_inspect(name: str, policy: dict[str, str]) -> dict:
            if name == candidate_launch.AUTHORED_WORKER_CONTAINER:
                return lives["worker"]
            if name == candidate_launch.AUTHORED_API_CONTAINER:
                return lives["api"]
            return {"name": name, "error": "inspect failed (no exec was attempted)"}

        original = candidate_launch.inspect_container
        candidate_launch.inspect_container = fake_inspect  # type: ignore[method-assign]
        try:
            rc = self.run_main()
        finally:
            candidate_launch.inspect_container = original
        self.assertEqual(rc, 0)
        manifest = json.loads((self.out / "dry-run-manifest.json").read_text())
        self.assertTrue(manifest["inspectGateOk"])
        self.assertEqual(manifest["candidateBindCount"], 37)
        self.assertEqual(manifest["replaceExistingBindMatched"], 15)
        self.assertEqual(manifest["inspectTargets"]["worker"], "rakazo-worker-1")
        self.assertEqual(manifest["inspectTargets"]["api"], "rakazo-api-1")
        self.assertGreater(len(manifest["services"][0]["preservedMounts"]), 0)
        self.assertGreater(len(manifest["services"][1]["preservedMounts"]), 0)
        replaced = [
            row
            for row in manifest["candidateBinds"]
            if row["action"] == "replace-existing-bind"
        ]
        self.assertEqual(len(replaced), 15)
        self.assertTrue(all(row["matchedInspectedDest"] for row in replaced))
        joined = " ".join(manifest["services"][0]["dockerRun"])
        self.assertIn("--pull=never", joined)
        self.assertIn("--read-only", joined)
        self.assertIn("no-new-privileges:true", joined)
        self.assertNotIn("/run/secrets", joined)

    def test_inspect_failure_dry_run_nonzero(self) -> None:
        called: list[str] = []

        def fake_inspect(name: str, policy: dict[str, str]) -> dict:
            called.append(name)
            return {"name": name, "error": "inspect failed (no exec was attempted)"}

        original = candidate_launch.inspect_container
        candidate_launch.inspect_container = fake_inspect  # type: ignore[method-assign]
        try:
            rc = self.run_main(
                RAKAZO_WORKER_CONTAINER="rakazo-worker-1",
                RAKAZO_API_CONTAINER="rakazo-api-1",
            )
        finally:
            candidate_launch.inspect_container = original
        self.assertEqual(rc, 2)
        self.assertEqual(called, ["rakazo-worker-1", "rakazo-api-1"])
        manifest = json.loads((self.out / "dry-run-manifest.json").read_text())
        self.assertFalse(manifest["inspectGateOk"])
        self.assertGreater(len(manifest["inspectGateErrors"]), 0)
        self.assertEqual(manifest["replaceExistingBindMatched"], 0)
        replaced = [
            row
            for row in manifest["candidateBinds"]
            if row["action"] == "replace-existing-bind"
        ]
        self.assertEqual(replaced, [])

    def test_wrong_name_does_not_retry_minus_one(self) -> None:
        called: list[str] = []

        def fake_inspect(name: str, policy: dict[str, str]) -> dict:
            called.append(name)
            return {"name": name, "error": "inspect failed (no exec was attempted)"}

        def fake_list(compose_service: str) -> tuple[list[str], str | None]:
            raise AssertionError(f"must not list compose replicas after explicit name {compose_service}")

        original_inspect = candidate_launch.inspect_container
        original_list = candidate_launch.list_compose_replica_names
        candidate_launch.inspect_container = fake_inspect  # type: ignore[method-assign]
        candidate_launch.list_compose_replica_names = fake_list  # type: ignore[method-assign]
        try:
            rc = self.run_main(
                RAKAZO_WORKER_CONTAINER="rakazo-worker",
                RAKAZO_API_CONTAINER="rakazo-api",
            )
        finally:
            candidate_launch.inspect_container = original_inspect
            candidate_launch.list_compose_replica_names = original_list
        self.assertEqual(rc, 2)
        self.assertEqual(called, ["rakazo-worker", "rakazo-api"])
        self.assertNotIn("rakazo-worker-1", called)
        self.assertNotIn("rakazo-api-1", called)

    def test_compose_identity_resolves_unique_replica_one(self) -> None:
        lives = {"worker": self.fake_live("worker"), "api": self.fake_live("api")}

        def fake_list(compose_service: str) -> tuple[list[str], str | None]:
            if compose_service == "worker":
                return ["rakazo-worker-1"], None
            if compose_service == "api":
                return ["rakazo-api-1"], None
            return [], f"unexpected {compose_service}"

        def fake_inspect(name: str, policy: dict[str, str]) -> dict:
            if name == "rakazo-worker-1":
                return lives["worker"]
            if name == "rakazo-api-1":
                return lives["api"]
            return {"name": name, "error": "inspect failed (no exec was attempted)"}

        original_inspect = candidate_launch.inspect_container
        original_list = candidate_launch.list_compose_replica_names
        candidate_launch.list_compose_replica_names = fake_list  # type: ignore[method-assign]
        candidate_launch.inspect_container = fake_inspect  # type: ignore[method-assign]
        try:
            rc = self.run_main(RAKAZO_WORKER_CONTAINER="", RAKAZO_API_CONTAINER="")
        finally:
            candidate_launch.inspect_container = original_inspect
            candidate_launch.list_compose_replica_names = original_list
        self.assertEqual(rc, 0)
        manifest = json.loads((self.out / "dry-run-manifest.json").read_text())
        self.assertEqual(manifest["inspectTargets"]["worker"], "rakazo-worker-1")
        self.assertEqual(manifest["inspectTargets"]["api"], "rakazo-api-1")
        self.assertEqual(manifest["replaceExistingBindMatched"], 15)

    def test_replace_requires_inspected_destination(self) -> None:
        live = self.fake_live("worker")
        live["sourceMounts"] = [
            row
            for row in live["sourceMounts"]
            if not str(row["destination"]).endswith("/executor.ts")
        ]

        def fake_inspect(name: str, policy: dict[str, str]) -> dict:
            if name.endswith("worker-1"):
                return live
            return self.fake_live("api")

        original = candidate_launch.inspect_container
        candidate_launch.inspect_container = fake_inspect  # type: ignore[method-assign]
        try:
            rc = self.run_main()
        finally:
            candidate_launch.inspect_container = original
        self.assertEqual(rc, 2)
        manifest = json.loads((self.out / "dry-run-manifest.json").read_text())
        self.assertFalse(manifest["inspectGateOk"])
        unmatched = [
            row
            for row in manifest["candidateBinds"]
            if row["action"] == "unmatched-replace-existing-bind"
        ]
        self.assertTrue(any(row["destination"].endswith("/executor.ts") for row in unmatched))

    def test_authored_container_names_are_compose_replica_one(self) -> None:
        self.assertEqual(candidate_launch.AUTHORED_WORKER_CONTAINER, "rakazo-worker-1")
        self.assertEqual(candidate_launch.AUTHORED_API_CONTAINER, "rakazo-api-1")
        commands = (HERE / "CANDIDATE-CAPTURE.md").read_text()
        self.assertIn("RAKAZO_WORKER_CONTAINER=rakazo-worker-1", commands)
        self.assertIn("RAKAZO_API_CONTAINER=rakazo-api-1", commands)
        self.assertNotRegex(commands, r"RAKAZO_WORKER_CONTAINER=rakazo-worker\s")
        self.assertNotRegex(commands, r"RAKAZO_API_CONTAINER=rakazo-api\s")
        help_text = (HERE / "host-launch.sh").read_text()
        self.assertIn("rakazo-worker-1", help_text)
        self.assertIn("rakazo-api-1", help_text)

    def test_execute_runs_api_after_worker_failure(self) -> None:
        lives = {"worker": self.fake_live("worker"), "api": self.fake_live("api")}
        docker_runs: list[str] = []

        def fake_inspect(name: str, policy: dict[str, str]) -> dict:
            if name == candidate_launch.AUTHORED_WORKER_CONTAINER:
                return lives["worker"]
            if name == candidate_launch.AUTHORED_API_CONTAINER:
                return lives["api"]
            return {"name": name, "error": "inspect failed (no exec was attempted)"}

        def fake_image(ref: str) -> dict:
            return {"local": True, "id": "sha256:deadbeef", "ref": ref}

        def fake_run(cmd, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:2] == ["docker", "run"]:
                name = cmd[cmd.index("--name") + 1]
                docker_runs.append(name)
                return subprocess.CompletedProcess(cmd, 1 if "worker" in name else 0)
            return subprocess.CompletedProcess(cmd, 0)

        original_inspect = candidate_launch.inspect_container
        original_image = candidate_launch.inspect_image
        original_run = candidate_launch.subprocess.run
        candidate_launch.inspect_container = fake_inspect  # type: ignore[method-assign]
        candidate_launch.inspect_image = fake_image  # type: ignore[method-assign]
        candidate_launch.subprocess.run = fake_run  # type: ignore[method-assign]
        try:
            rc = self.run_main(execute=True)
        finally:
            candidate_launch.inspect_container = original_inspect
            candidate_launch.inspect_image = original_image
            candidate_launch.subprocess.run = original_run
        self.assertEqual(rc, 1)
        self.assertEqual(len(docker_runs), 2)
        self.assertTrue(any("worker" in name for name in docker_runs))
        self.assertTrue(any("api" in name for name in docker_runs))

    def test_nonvacuous_checker_accepts_execute_out_service_layout(self) -> None:
        out = Path(tempfile.mkdtemp())
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
        }
        compaction = {
            "summary": "New password: [withheld]",
            "hasCurrent": False,
            "hasStale": False,
            "hasAllSet": False,
        }
        for service in ("worker", "api"):
            dest = out / service
            dest.mkdir()
            scenarios = {
                "generated-secret": {
                    **passing,
                    "httpRequestCount": 2,
                    "httpHasBareDoneNudge": False,
                    "stubEmittedNudgeFiller": False,
                    "finalHasNotVerified": False,
                },
                "stale-secret": {
                    **passing,
                    "httpRequestCount": 2,
                    "httpHasBareDoneNudge": False,
                    "stubEmittedNudgeFiller": False,
                },
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
        rc = candidate_launch.run_nonvacuous_checker(out)
        self.assertEqual(rc, 0)

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
