#!/usr/bin/env python3
"""Enumerate env reads from actual source, then compare to schema + allowlist.

Unexplained consumed names block preflight. Semantics come from source comparisons,
not from guessing at env names.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

BUNDLE = Path(__file__).resolve().parent
SCHEMA_PATH = BUNDLE / "config-coverage-schema.json"
MODULES_PATH = BUNDLE / "config-coverage-modules.txt"
ALLOWLIST_PATH = BUNDLE / "allowlisted-env.txt"

ENV_ATTR = re.compile(r"(?:process\.env|env)\.([A-Z][A-Z0-9_]*)")
ENV_INDEX = re.compile(r"(?:process\.env|env)\[(['\"])([A-Z][A-Z0-9_]*)\1\]")
BOTDIR_CALL = re.compile(r"""botdir(?:Switch|Number)\(\s*['\"]([A-Z][A-Z0-9_]*)['\"]""")

FORWARD_KINDS = {
    "off_when_0",
    "on_when_1",
    "present_not_0",
    "botdir_switch",
    "default_on_kill_switch",
    "int",
    "model_list",
    "model_json",
    "disabled_tool_csv",
    "iana_timezone",
}


def composed_source_roots(bundle: Path = BUNDLE) -> list[Path]:
    raw = os.environ.get("ISOLATED_CAPTURE_COMPOSED_SOURCE", "").strip()
    listed: list[str] = []
    if raw:
        listed.extend(part.strip() for part in raw.split(":") if part.strip())
    marker = bundle / "composed-source.path"
    if marker.exists():
        listed.extend(
            line.strip()
            for line in marker.read_text().splitlines()
            if line.strip() and not line.startswith("#")
        )
    roots: list[Path] = []
    seen: set[str] = set()
    for item in listed:
        path = Path(item)
        key = str(path.resolve()) if path.exists() else str(path)
        if key in seen:
            continue
        seen.add(key)
        if path.is_dir():
            roots.append(path)
    return roots


def load_schema(path: Path = SCHEMA_PATH) -> dict:
    return json.loads(path.read_text())


def load_modules(path: Path = MODULES_PATH) -> list[dict[str, object]]:
    rows = []
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        roles = [item.strip() for item in parts[0].split(",") if item.strip()]
        live = parts[1].strip() if len(parts) > 1 else ""
        excerpt = parts[2].strip() if len(parts) > 2 else ""
        rows.append({"consumedBy": roles, "live": live, "excerpt": excerpt})
    return rows


def extract_env_names(text: str) -> set[str]:
    names = set(ENV_ATTR.findall(text))
    names.update(match[1] for match in ENV_INDEX.findall(text))
    names.update(BOTDIR_CALL.findall(text))
    return names


def load_allowlist(path: Path = ALLOWLIST_PATH) -> dict[str, str]:
    policy: dict[str, str] = {}
    if not path.exists():
        return policy
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "\t" in line:
            key, kind = line.split("\t", 1)
        else:
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            key, kind = parts
        policy[key.strip()] = kind.strip()
    return policy


def scan_sources(bundle: Path = BUNDLE, modules: list[dict[str, object]] | None = None) -> dict[str, list[str]]:
    rows = modules if modules is not None else load_modules()
    consumed: dict[str, set[str]] = {}
    roots = composed_source_roots(bundle)
    for row in rows:
        roles = list(row["consumedBy"])
        live = str(row.get("live") or "")
        if not live:
            continue
        for root in roots:
            candidate = root / live
            if not candidate.exists():
                continue
            for name in extract_env_names(candidate.read_text()):
                consumed.setdefault(name, set()).update(roles)
                consumed[name].add(f"file:{candidate.name}")
    return {name: sorted(origins) for name, origins in sorted(consumed.items())}


def preflight(
    bundle: Path = BUNDLE,
    schema: dict | None = None,
    consumed: dict[str, list[str]] | None = None,
    allowlist: dict[str, str] | None = None,
    model_json_keys: set[str] | None = None,
    never_forward: set[str] | None = None,
) -> dict[str, object]:
    schema = schema if schema is not None else load_schema(bundle / SCHEMA_PATH.name)
    consumed = consumed if consumed is not None else scan_sources(bundle)
    allowlist = allowlist if allowlist is not None else load_allowlist(bundle / ALLOWLIST_PATH.name)
    fields: dict[str, dict] = schema.get("fields") or {}
    known_kwargs = set((schema.get("modelJsonKnownFields") or {}).keys())

    unexplained: list[str] = []
    mismatches: list[str] = []
    omit_without_reason: list[str] = []
    blocked_forward: list[str] = []

    for name in consumed:
        spec = fields.get(name)
        if spec is None:
            unexplained.append(name)
            continue
        disposition = spec.get("disposition")
        kind = spec.get("kind")
        if disposition == "omit":
            if not spec.get("omitReason"):
                omit_without_reason.append(name)
            if name in allowlist and allowlist[name] in FORWARD_KINDS:
                mismatches.append(f"{name}: omitted in schema but allowlisted as {allowlist[name]}")
            if never_forward is not None and name in never_forward:
                pass
            continue
        if disposition != "forward":
            unexplained.append(name)
            continue
        if kind not in FORWARD_KINDS:
            mismatches.append(f"{name}: forward kind {kind} is not a typed known-safe kind")
            continue
        listed = allowlist.get(name)
        if listed != kind:
            mismatches.append(f"{name}: schema kind {kind} vs allowlist {listed}")
        if never_forward is not None and name in never_forward:
            blocked_forward.append(name)

    if model_json_keys is not None and model_json_keys != known_kwargs:
        mismatches.append(
            f"MODEL_JSON_KEYS {sorted(model_json_keys)} != schema {sorted(known_kwargs)}"
        )

    assist_prompt = fields.get("RAKAZO_ASSIST_PROMPT") or {}
    if assist_prompt.get("kind") != "off_when_0" or assist_prompt.get("disposition") != "forward":
        mismatches.append("RAKAZO_ASSIST_PROMPT must be off_when_0 forwarded (source === \"0\"), not prompt text")
    if allowlist.get("RAKAZO_ASSIST_PROMPT") == "never":
        mismatches.append("exact-failure: RAKAZO_ASSIST_PROMPT allowlisted never (treated as prompt text)")
    if allowlist.get("RAKAZO_ASSIST_STABLE_PREFIX") == "never":
        mismatches.append("exact-failure: RAKAZO_ASSIST_STABLE_PREFIX allowlisted never (treated as prefix text)")
    if "medium_effort" not in known_kwargs:
        mismatches.append("exact-failure: medium_effort missing from modelJsonKnownFields")
    if "thinking_budget" in known_kwargs:
        mismatches.append("thinking_budget is a top-level env/body field, not a chat_template_kwargs key")

    roots = composed_source_roots(bundle)
    if not roots:
        mismatches.append(
            "composed source required: set ISOLATED_CAPTURE_COMPOSED_SOURCE or composed-source.path "
            "to actual overlay/composed adapters/src directories; bundle excerpts are not source of truth"
        )

    ok = not (unexplained or mismatches or omit_without_reason or blocked_forward)
    return {
        "ok": ok,
        "consumed": consumed,
        "unexplained": unexplained,
        "mismatches": mismatches,
        "omitWithoutReason": omit_without_reason,
        "blockedForward": blocked_forward,
        "forwarded": sorted(
            name
            for name, spec in fields.items()
            if spec.get("disposition") == "forward"
        ),
        "explicitOmitted": sorted(
            name
            for name, spec in fields.items()
            if spec.get("disposition") == "omit"
        ),
        "modelJsonKnownFields": sorted(known_kwargs),
        "composedSourceRoots": [str(path) for path in composed_source_roots(bundle)],
    }


def main() -> int:
    report = preflight()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
