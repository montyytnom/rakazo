#!/usr/bin/env python3
"""Targeted path and env-privacy tests for the isolated-capture launcher."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import host_launch

BUNDLE = Path(__file__).resolve().parent
LIVE_PROMPT = "THIS-MUST-NEVER-APPEAR production assist prompt string"


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class MountAllowlistTests(unittest.TestCase):
    def test_keeps_overlay_source_login_guard_and_session_modules(self) -> None:
        for dest in (
            "/app/packages/adapters/src/login-guard.ts",
            "/app/packages/adapters/src/page-browser-session.ts",
            "/app/packages/adapters/src/executor.ts",
            "/app/packages/adapters/src/botdir.ts",
        ):
            decision, reason = host_launch.classify_mount(dest)
            self.assertEqual(decision, "allow", dest)
            self.assertEqual(reason, "app-source")

    def test_denies_state_paths_not_code_filenames(self) -> None:
        denied = [
            "/run/login-guard",
            "/run/login-guard/policy.txt",
            "/run/op-data",
            "/run/secrets/scrapling_token",
            "/data",
            "/data/postgres",
            "/var/lib/postgresql",
            "/app/packages/adapters/.env",
        ]
        for dest in denied:
            decision, reason = host_launch.classify_mount(dest)
            self.assertEqual(decision, "deny", f"{dest} {reason}")
            self.assertNotIn("session", reason)
            self.assertFalse(reason.startswith("excluded-appdata-secret"))

    def test_worker_35_api_40_source_mounts_retained(self) -> None:
        worker = [
            {"destination": f"/app/packages/adapters/src/w{index}.ts"} for index in range(33)
        ] + [
            {"destination": "/app/packages/adapters/src/login-guard.ts"},
            {"destination": "/app/packages/adapters/src/page-browser-session.ts"},
            {"destination": "/run/login-guard"},
            {"destination": "/run/op-data"},
            {"destination": "/data"},
            {"destination": "/run/secrets/scrapling_token"},
        ]
        api = [
            {"destination": f"/app/packages/adapters/src/a{index}.ts"} for index in range(39)
        ] + [
            {"destination": "/app/packages/adapters/src/page-browser-session.ts"},
            {"destination": "/run/login-guard"},
            {"destination": "/data"},
        ]
        worker_ok, worker_skip = host_launch.classify_mounts(worker)
        api_ok, api_skip = host_launch.classify_mounts(api)
        self.assertEqual(len(worker_ok), 35)
        self.assertEqual(len(api_ok), 40)
        self.assertTrue(any(row["destination"].endswith("login-guard.ts") for row in worker_ok))
        self.assertTrue(
            any(row["destination"].endswith("page-browser-session.ts") for row in worker_ok)
        )
        self.assertTrue(any(row["destination"].endswith("page-browser-session.ts") for row in api_ok))
        self.assertTrue(any(row["destination"] == "/run/login-guard" for row in worker_skip))
        self.assertFalse(any(row["destination"].endswith("login-guard.ts") for row in worker_skip))


class EnvPrivacyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = host_launch.load_env_policy(BUNDLE)

    def test_assist_prompt_hashed_not_forwarded(self) -> None:
        classified = host_launch.classify_env(
            {
                "RAKAZO_ASSIST_PROMPT": LIVE_PROMPT,
                "RAKAZO_ASSIST_STABLE_PREFIX": "custom-prefix-value",
                "RAKAZO_THINKING_BUDGET": "64",
                "RAKAZO_THINKING_BUDGET_MODELS": "qwen3.8-flash-next",
                "NODE_ENV": "production",
                "DATABASE_URL": "postgres://example",
                "NODE_OPTIONS": "--require ./secret.js",
            },
            self.policy,
        )
        blob = json.dumps(classified)
        self.assertNotIn(LIVE_PROMPT, blob)
        self.assertNotIn("custom-prefix-value", blob)
        self.assertNotIn("postgres://example", blob)
        self.assertNotIn("--require ./secret.js", blob)
        self.assertEqual(classified["forwarded"]["RAKAZO_THINKING_BUDGET"], "64")
        self.assertNotIn("RAKAZO_ASSIST_PROMPT", classified["forwarded"])
        self.assertNotIn("RAKAZO_ASSIST_STABLE_PREFIX", classified["forwarded"])
        self.assertNotIn("NODE_OPTIONS", classified["forwarded"])
        assist = next(row for row in classified["observed"] if row["key"] == "RAKAZO_ASSIST_PROMPT")
        self.assertEqual(assist["sha256"], sha(LIVE_PROMPT))
        self.assertEqual(assist["replacedWith"], "synthetic-unset")

    def test_plan_omits_assist_from_docker_e(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            live = {
                "sourceMounts": [
                    {
                        "source": "/opt/overlays/login-guard.ts",
                        "destination": "/app/packages/adapters/src/login-guard.ts",
                        "mode": "ro",
                    }
                ],
                "skippedMounts": [],
                "forwardedEnv": {"RAKAZO_THINKING_BUDGET": "64"},
                "envPrivacy": {"observed": []},
            }
            plan = host_launch.plan_service(
                "worker",
                "sha256:deadbeef",
                "unused",
                BUNDLE,
                out,
                self.policy,
                live=live,
            )
            joined = " ".join(plan["dockerRunRawForExecute"])
            self.assertNotIn(LIVE_PROMPT, joined)
            self.assertNotIn("RAKAZO_ASSIST_PROMPT=", joined)
            self.assertIn("--cap-drop", plan["dockerRun"])
            self.assertIn("ALL", plan["dockerRun"])
            self.assertIn("no-new-privileges:true", plan["dockerRun"])
            self.assertIn("--pids-limit", plan["dockerRun"])
            self.assertIn("256", plan["dockerRun"])
            dests = [row["destination"] for row in plan["mounts"]]
            self.assertIn("/app/packages/adapters/src/login-guard.ts", dests)
            self.assertIn("/app/packages/adapters/src/isolated-capture.ts", dests)
            manifest = host_launch.build_manifest(plan, plan, False)
            text = json.dumps(manifest)
            self.assertNotIn(LIVE_PROMPT, text)
            self.assertNotIn("dockerRunRawForExecute", text)


class IsolatedSourcesTests(unittest.TestCase):
    def test_isolated_capture_is_the_only_runtime_bind(self) -> None:
        rows = host_launch.load_isolated_sources(BUNDLE)
        dests = [row["destination"] for row in rows]
        self.assertEqual(dests, ["/app/packages/adapters/src/isolated-capture.ts"])
        self.assertTrue(Path(rows[0]["source"]).name == "isolated-capture.ts")


if __name__ == "__main__":
    unittest.main(verbosity=2)
