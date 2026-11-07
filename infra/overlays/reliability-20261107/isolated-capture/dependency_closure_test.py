#!/usr/bin/env python3
"""Image-shaped dependency closure for isolated-capture.ts. Not a live image test."""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

BUNDLE = Path(__file__).resolve().parent
REPO_HARNESS = BUNDLE.parents[3] / "packages" / "adapters" / "src" / "isolated-capture.ts"
IMPORT_RE = re.compile(r"""from\s+["'](\./[^"']+)["']""")


def harness_source() -> Path:
    bundled = BUNDLE / "isolated-capture.ts"
    if bundled.exists():
        return bundled
    return REPO_HARNESS


def parse_names(path: Path) -> set[str]:
    names = set()
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        names.add(line.split()[0])
    return names


def relative_imports(source: Path) -> list[str]:
    found = []
    for match in IMPORT_RE.finditer(source.read_text()):
        spec = match.group(1)
        found.append(spec)
    return found


def spec_to_basename(spec: str) -> str:
    name = spec.rsplit("/", 1)[-1]
    if name.endswith(".js"):
        return name[:-3] + ".ts"
    return name


class DependencyClosureTests(unittest.TestCase):
    def test_image_shaped_tree_resolves_without_capture_harness(self) -> None:
        harness = harness_source()
        self.assertTrue(harness.exists(), "isolated-capture.ts missing from bundle and repo")
        image = parse_names(BUNDLE / "image-shaped-926710a-adapters.txt")
        extras = parse_names(BUNDLE / "image-shaped-overlay-extras.txt")
        shaped = image | extras
        self.assertNotIn("capture-harness.ts", shaped)
        self.assertNotIn("isolated-capture.ts", shaped)
        self.assertIn("login-guard.ts", extras)
        self.assertIn("page-browser-session.ts", image)

        imports = relative_imports(harness)
        self.assertTrue(imports)
        self.assertFalse(any("capture-harness" in spec for spec in imports))
        self.assertFalse(any("history-compaction" in spec for spec in imports))

        isolated_dests = []
        for raw in (BUNDLE / "isolated-sources.txt").read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            rel, dest = line.split("\t", 1)
            isolated_dests.append((rel.strip(), dest.strip()))
            self.assertNotIn(
                Path(rel.strip()).name,
                shaped,
                "isolated source must not replace a deployed runtime file",
            )

        with tempfile.TemporaryDirectory() as tmp:
            tree = Path(tmp) / "packages" / "adapters" / "src"
            tree.mkdir(parents=True)
            for name in sorted(shaped):
                (tree / name).write_text("// image-shaped stub\n")
            for rel, dest in isolated_dests:
                dest_name = Path(dest).name
                src = BUNDLE / rel
                (tree / dest_name).write_text((src if src.exists() else harness).read_text())
            missing = []
            for spec in imports:
                basename = spec_to_basename(spec)
                if not (tree / basename).exists():
                    missing.append(spec)
            self.assertEqual(missing, [], f"unresolved relative imports on image-shaped tree: {missing}")

            report = {
                "kind": "image-shaped-dependency-closure",
                "liveImageTested": False,
                "imageShapedAdapterCount": len(shaped),
                "isolatedSources": [rel for rel, _ in isolated_dests],
                "relativeImports": imports,
                "unresolved": missing,
                "captureHarnessImported": False,
                "parentReportedImageIdsNotExercised": {
                    "worker": "47d3423567b35333059f9ff55817c03656a43431539f0478e3eb959e13e9cdc6",
                    "api": "c500071f5b2fde76d4bfca3ae883afb817c2265e2f113515cdb59c653d469f1f",
                    "note": "parent-reported local image ids; this test uses a 926710a-plus-overlay name snapshot only",
                },
            }
            self.assertFalse(report["liveImageTested"])
            report_path = Path("/tmp/isolated-capture-dependency-closure.json")
            report_path.write_text(json.dumps(report, indent=2) + "\n")
            self.assertTrue(report_path.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
