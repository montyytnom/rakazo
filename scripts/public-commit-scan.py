#!/usr/bin/env python3
"""Audit the public committed tree and this branch's history.

Prints path, line, and pattern name only. Never prints matched text.
"""
from __future__ import annotations

import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
RANGE = "926710a09b30a6c1f83029da88dfe06656b031f2..HEAD"

HIGH = [
    ("weightlab_packet", re.compile(r"WeightLab|rakazo-dev-only|\bheldout\b", re.I)),
    ("overlay_tarball", re.compile(r"overlay-export.*\.tgz|\.tgz.*overlay", re.I)),
    ("pem_private_key", re.compile(r"BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY")),
    ("aws_access_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("live_sk_prefix", re.compile(r"(?<![\w-])sk-[a-zA-Z0-9]{20,}")),
    ("scrapling_token_file", re.compile(r"/opt/docker/rakazo/secrets/scrapling_token")),
    ("jwt_compact", re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.")),
]
BROAD = [
    ("assignment_secret", re.compile(r"(api[_-]?key|secret|token|password)\s*[:=]\s*['\"][^'\"]{8,}", re.I)),
]


def allow_high(path: str, pattern: str, line: str) -> str | None:
    if "capture-harness.test.ts" in path and pattern == "live_sk_prefix":
        return "negative assertion"
    if pattern == "live_sk_prefix" and "not.toMatch" in line:
        return "negative assertion"
    if path.endswith(".test.ts"):
        return "test fixture"
    if "public-commit-scan" in path or "re.compile" in line:
        return "scanner documents the pattern"
    return None


def allow_broad(path: str, line: str) -> str:
    if path.endswith(".test.ts") or path.endswith(".test.tsx"):
        return "test"
    if "inputSchema" in line or "description:" in line or "fill_secret" in line:
        return "tool-schema"
    if path.startswith("docs/") or path.endswith(".md"):
        return "docs"
    if "public-commit-scan" in path:
        return "scanner"
    return "other"


def scan(path: str, text: str, patterns: list[tuple[str, re.Pattern[str]]]):
    for index, line in enumerate(text.splitlines(), 1):
        for name, pattern in patterns:
            if pattern.search(line):
                yield path, index, name, line


def files() -> list[str]:
    raw = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    return [item.decode() for item in raw.split(b"\0") if item]


def read(path: str) -> str | None:
    try:
        return (ROOT / path).read_text(encoding="utf-8")
    except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError):
        return None


def main() -> int:
    print(f"scope_tree: git ls-files at HEAD ({ROOT})")
    print(f"scope_history: git log -p {RANGE}")
    print("values: not printed")
    tracked = files()
    print(f"tracked_files: {len(tracked)}")
    forbidden = [
        path
        for path in tracked
        if re.search(r"(?i)weightlab|heldout|overlay-export|\.tgz$|scrapling_token$", path)
    ]
    print("forbidden_filenames: " + (" ".join(forbidden) if forbidden else "(none)"))

    high_hits = []
    broad_classes: Counter[str] = Counter()
    for path in tracked:
        if path.endswith((".png", ".jpg", ".webp", ".woff", ".woff2", ".pdf", ".bin")):
            continue
        text = read(path)
        if text is None:
            continue
        for _, index, name, line in scan(path, text, HIGH):
            reason = allow_high(path, name, line)
            high_hits.append((path, index, name, reason or "UNALLOWLISTED"))
        for _, _, _, line in scan(path, text, BROAD):
            broad_classes[allow_broad(path, line)] += 1

    print("high_signal_committed_tree:")
    if high_hits:
        for path, index, name, kind in high_hits:
            print(f"  {path}:{index} pattern={name} {kind}")
    else:
        print("  (none)")

    print("broad_assignment_secret_classes:")
    for klass, count in sorted(broad_classes.items()):
        print(f"  {klass}: {count}")
    print(
        "broad_false_positive_note: assignment_secret matches test doubles, schema copy, and docs that mention password=; those are not live credentials"
    )

    diff = subprocess.check_output(
        ["git", "log", "-p", RANGE, "--"],
        cwd=ROOT,
        text=True,
        errors="replace",
    )
    hist = []
    for _, index, name, line in scan(f"history:{RANGE}", diff, HIGH):
        reason = allow_high("history", name, line)
        hist.append((index, name, reason or "UNALLOWLISTED"))
    print("high_signal_branch_history:")
    if hist:
        for index, name, kind in hist:
            print(f"  history-line:{index} pattern={name} {kind}")
    else:
        print("  (none)")

    bad = [row for row in high_hits if row[3] == "UNALLOWLISTED"] + [
        row for row in hist if row[2] == "UNALLOWLISTED"
    ]
    print(f"unallowlisted_high_signal: {len(bad)}")
    return 1 if bad or forbidden else 0


if __name__ == "__main__":
    sys.exit(main())
