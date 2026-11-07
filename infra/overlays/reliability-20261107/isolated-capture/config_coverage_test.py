#!/usr/bin/env python3
"""Exact Run8 fidelity failures: assist 0/1 switches, medium_effort, unexplained env."""

from __future__ import annotations

import json
import unittest
from copy import deepcopy
from pathlib import Path

import config_coverage
import host_launch

BUNDLE = Path(__file__).resolve().parent


class ExactFailureTests(unittest.TestCase):
    def test_assist_1_must_be_forwarded_not_treated_as_prompt_text(self) -> None:
        policy = host_launch.load_env_policy(BUNDLE)
        self.assertEqual(policy["RAKAZO_ASSIST_PROMPT"], "off_when_0")
        self.assertEqual(policy["RAKAZO_ASSIST_STABLE_PREFIX"], "off_when_0")
        self.assertNotEqual(policy["RAKAZO_ASSIST_PROMPT"], "never")
        classified = host_launch.classify_env(
            {"RAKAZO_ASSIST_PROMPT": "1", "RAKAZO_ASSIST_STABLE_PREFIX": "1"},
            policy,
        )
        self.assertEqual(classified["forwarded"]["RAKAZO_ASSIST_PROMPT"], "1")
        self.assertEqual(classified["forwarded"]["RAKAZO_ASSIST_STABLE_PREFIX"], "1")
        for key in ("RAKAZO_ASSIST_PROMPT", "RAKAZO_ASSIST_STABLE_PREFIX"):
            row = next(item for item in classified["observed"] if item["key"] == key)
            self.assertTrue(row["forwarded"])
            self.assertNotIn("replacedWith", row)

    def test_assist_freeform_prompt_text_is_rejected(self) -> None:
        policy = host_launch.load_env_policy(BUNDLE)
        live = "THIS-MUST-NEVER-APPEAR production assist prompt string"
        classified = host_launch.classify_env(
            {"RAKAZO_ASSIST_PROMPT": live, "RAKAZO_ASSIST_STABLE_PREFIX": "custom-prefix-value"},
            policy,
        )
        blob = json.dumps(classified)
        self.assertNotIn(live, blob)
        self.assertNotIn("custom-prefix-value", blob)
        self.assertNotIn("RAKAZO_ASSIST_PROMPT", classified["forwarded"])
        self.assertNotIn("RAKAZO_ASSIST_STABLE_PREFIX", classified["forwarded"])

    def test_name_based_never_policy_is_the_documented_assist_failure(self) -> None:
        """Run8 stop: name-based sanitization treated ASSIST_* as prompt text / never."""
        broken = {
            "RAKAZO_ASSIST_PROMPT": "never",
            "RAKAZO_ASSIST_STABLE_PREFIX": "never",
        }
        classified = host_launch.classify_env(
            {"RAKAZO_ASSIST_PROMPT": "1", "RAKAZO_ASSIST_STABLE_PREFIX": "1"},
            broken,
        )
        self.assertNotIn("RAKAZO_ASSIST_PROMPT", classified["forwarded"])
        self.assertNotIn("RAKAZO_ASSIST_STABLE_PREFIX", classified["forwarded"])
        assist = next(row for row in classified["observed"] if row["key"] == "RAKAZO_ASSIST_PROMPT")
        self.assertEqual(assist["replacedWith"], "synthetic-unset")

    def test_medium_effort_boolean_is_preserved_in_chat_template_kwargs(self) -> None:
        self.assertIn("medium_effort", host_launch.MODEL_JSON_KEYS)
        self.assertIn("enable_thinking", host_launch.MODEL_JSON_KEYS)
        self.assertNotIn("thinking_budget", host_launch.MODEL_JSON_KEYS)
        ok, cleaned = host_launch.parse_typed_value(
            "model_json",
            '{"enable_thinking":true,"medium_effort":true}',
        )
        self.assertTrue(ok)
        parsed = json.loads(cleaned)
        self.assertIs(parsed["medium_effort"], True)
        self.assertIs(parsed["enable_thinking"], True)

    def test_dropping_medium_effort_is_the_documented_kwargs_failure(self) -> None:
        """Run8 stop: MODEL_JSON_KEYS lacked medium_effort so sanitization changed serializer bytes."""
        old_keys = frozenset({"enable_thinking", "thinking_budget"})
        self.assertNotIn("medium_effort", old_keys)
        raw = json.loads('{"enable_thinking":true,"medium_effort":true}')
        cleaned = {key: value for key, value in raw.items() if key in old_keys}
        self.assertNotIn("medium_effort", cleaned)

    def test_non_boolean_kwargs_value_is_rejected(self) -> None:
        ok, cleaned = host_launch.parse_typed_value(
            "model_json",
            '{"enable_thinking":true,"medium_effort":1}',
        )
        self.assertFalse(ok)
        self.assertIsNone(cleaned)

    def test_unexplained_kwargs_key_is_rejected(self) -> None:
        ok, cleaned = host_launch.parse_typed_value(
            "model_json",
            '{"enable_thinking":true,"medium_effort":true,"extra_flag":true}',
        )
        self.assertFalse(ok)
        self.assertIsNone(cleaned)

    def test_unexplained_consumed_env_blocks_preflight(self) -> None:
        schema = config_coverage.load_schema()
        truncated = deepcopy(schema)
        del truncated["fields"]["RAKAZO_ASSIST_PROMPT"]
        consumed = config_coverage.scan_sources(BUNDLE)
        self.assertIn("RAKAZO_ASSIST_PROMPT", consumed)
        report = config_coverage.preflight(
            BUNDLE,
            schema=truncated,
            consumed=consumed,
            allowlist=config_coverage.load_allowlist(),
            model_json_keys=host_launch.MODEL_JSON_KEYS,
            never_forward=host_launch.NEVER_FORWARD,
        )
        self.assertFalse(report["ok"])
        self.assertIn("RAKAZO_ASSIST_PROMPT", report["unexplained"])

    def test_schema_semantics_are_source_comparisons_not_name_guesses(self) -> None:
        schema = config_coverage.load_schema()
        prompt = schema["fields"]["RAKAZO_ASSIST_PROMPT"]
        prefix = schema["fields"]["RAKAZO_ASSIST_STABLE_PREFIX"]
        kwargs = schema["fields"]["RAKAZO_OPENAI_COMPAT_CHAT_TEMPLATE_KWARGS"]
        self.assertIn('=== "0"', prompt["semantics"])
        self.assertIn("not prompt text", prompt["semantics"])
        self.assertIn('=== "0"', prefix["semantics"])
        self.assertNotIn("PROMPT", prompt["kind"])
        self.assertEqual(kwargs["kind"], "model_json")
        self.assertEqual(
            schema["modelJsonKnownFields"],
            {"enable_thinking": "boolean", "medium_effort": "boolean"},
        )

    def test_preflight_passes_committed_schema(self) -> None:
        report = config_coverage.preflight(
            BUNDLE,
            model_json_keys=host_launch.MODEL_JSON_KEYS,
            never_forward=host_launch.NEVER_FORWARD,
        )
        self.assertEqual(report["unexplained"], [], msg=str(report))
        self.assertEqual(report["mismatches"], [], msg=str(report))
        self.assertEqual(report["blockedForward"], [], msg=str(report))
        self.assertTrue(report["ok"], msg=str(report))
        self.assertIn("RAKAZO_ASSIST_PROMPT", report["forwarded"])
        self.assertIn("medium_effort", report["modelJsonKnownFields"])

    def test_never_forward_assist_blocks_preflight(self) -> None:
        report = config_coverage.preflight(
            BUNDLE,
            model_json_keys=host_launch.MODEL_JSON_KEYS,
            never_forward=frozenset({"RAKAZO_ASSIST_PROMPT", "RAKAZO_ASSIST_STABLE_PREFIX"}),
        )
        self.assertFalse(report["ok"])
        self.assertIn("RAKAZO_ASSIST_PROMPT", report["blockedForward"])
        self.assertIn("RAKAZO_ASSIST_STABLE_PREFIX", report["blockedForward"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
