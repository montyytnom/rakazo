#!/usr/bin/env python3
"""Targeted path and env-privacy tests for the isolated-capture launcher."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import host_launch

BUNDLE = Path(__file__).resolve().parent
LIVE_PROMPT = "THIS-MUST-NEVER-APPEAR production assist prompt string"


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

    def test_worker_37_api_41_source_mounts_retained(self) -> None:
        worker = [
            {"destination": f"/app/packages/adapters/src/w{index}.ts"} for index in range(35)
        ] + [
            {"destination": "/app/packages/adapters/src/login-guard.ts"},
            {"destination": "/app/packages/adapters/src/page-browser-session.ts"},
            {"destination": "/run/login-guard"},
            {"destination": "/run/op-data"},
            {"destination": "/data"},
            {"destination": "/run/secrets/scrapling_token"},
        ]
        api = [
            {"destination": f"/app/packages/adapters/src/a{index}.ts"} for index in range(40)
        ] + [
            {"destination": "/app/packages/adapters/src/page-browser-session.ts"},
            {"destination": "/run/login-guard"},
            {"destination": "/data"},
        ]
        worker_ok, worker_skip = host_launch.classify_mounts(worker)
        api_ok, api_skip = host_launch.classify_mounts(api)
        self.assertEqual(len(worker_ok), 37)
        self.assertEqual(len(api_ok), 41)
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

    def test_assist_switches_and_typed_scalars_forward_without_leaking_secrets(self) -> None:
        classified = host_launch.classify_env(
            {
                "RAKAZO_ASSIST_PROMPT": "1",
                "RAKAZO_ASSIST_STABLE_PREFIX": "1",
                "RAKAZO_THINKING_BUDGET": "64",
                "RAKAZO_THINKING_BUDGET_MODELS": "qwen3.8-flash-next",
                "RAKAZO_OPENAI_COMPAT_CHAT_TEMPLATE_KWARGS": '{"enable_thinking":true,"medium_effort":true}',
                "NODE_ENV": "production",
                "DATABASE_URL": "postgres://example",
                "NODE_OPTIONS": "--require ./secret.js",
                "OPENROUTER_API_KEY": "sk-live-must-not-appear",
            },
            self.policy,
        )
        blob = json.dumps(classified)
        self.assertNotIn("postgres://example", blob)
        self.assertNotIn("--require ./secret.js", blob)
        self.assertNotIn("sk-live-must-not-appear", blob)
        self.assertEqual(classified["forwarded"]["RAKAZO_ASSIST_PROMPT"], "1")
        self.assertEqual(classified["forwarded"]["RAKAZO_ASSIST_STABLE_PREFIX"], "1")
        self.assertEqual(classified["forwarded"]["RAKAZO_THINKING_BUDGET"], "64")
        kwargs = json.loads(classified["forwarded"]["RAKAZO_OPENAI_COMPAT_CHAT_TEMPLATE_KWARGS"])
        self.assertIs(kwargs["medium_effort"], True)
        self.assertIs(kwargs["enable_thinking"], True)
        self.assertNotIn("NODE_OPTIONS", classified["forwarded"])
        self.assertNotIn("DATABASE_URL", classified["forwarded"])
        self.assertNotIn("OPENROUTER_API_KEY", classified["forwarded"])

    def test_plan_forwards_assist_1_and_keeps_hardening(self) -> None:
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
                "forwardedEnv": {
                    "RAKAZO_THINKING_BUDGET": "64",
                    "RAKAZO_ASSIST_PROMPT": "1",
                    "RAKAZO_ASSIST_STABLE_PREFIX": "1",
                    "RAKAZO_OPENAI_COMPAT_CHAT_TEMPLATE_KWARGS": '{"enable_thinking":true,"medium_effort":true}',
                },
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
            self.assertIn("RAKAZO_ASSIST_PROMPT=1", joined)
            self.assertIn("RAKAZO_ASSIST_STABLE_PREFIX=1", joined)
            self.assertIn("medium_effort", joined)
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
