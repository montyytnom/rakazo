#!/usr/bin/env python3
"""Candidate-capture launcher. Inspect-only of production; no exec/mutation.

Replaces matching inspected /app dests with staged AFTER files, adds new RO
binds, preserves other allowed app-source mounts. Skip-unchanged-image rows
are not bound. Dry-run lists all 37 candidate binds. Staging is capture-only.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

PREFIX = "rakazo-candidate-capture"
STAGE_MARK = "rakazo-candidate-capture-stage"
APP_PREFIX = "/app"
STATE_PREFIXES = (
    "/data",
    "/run/login-guard",
    "/run/op-data",
    "/run/secrets",
    "/var/lib",
)
STATE_COMPONENTS = frozenset({"appdata", "postgres", "postgresql", "redis"})
FORBIDDEN_STAGE_ROOTS = (
    "/opt/docker",
    "/app",
    "/run",
    "/var/lib/docker",
    "/opt/rakazo",
)
MODEL_LIST_RE = re.compile(r"^[A-Za-z0-9._,+-]+$")
INT_RE = re.compile(r"^-?\d{1,12}$")
IANA_TZ_RE = re.compile(r"^(UTC|[A-Za-z_]+(?:/[A-Za-z0-9_+-]+)+)$")
DISABLED_TOOL_CSV = "render_plot,skill_create,skill_update,skill_delete,create_space"
BOOL_VALUES = {"0": "0", "1": "1", "true": "true", "false": "false"}
MODEL_JSON_KEYS = frozenset({"enable_thinking", "medium_effort"})
NEVER_FORWARD = frozenset()
ZERO_ONE_KINDS = frozenset({"off_when_0", "on_when_1", "present_not_0"})
DEFAULT_ON_KILL_SWITCH = frozenset({"0", "1", "true", "false", "off", "no", "on", "yes"})
CPU_LIMIT = "2"
MEMORY_LIMIT = "2g"
PIDS_LIMIT = "256"
SECRET_KEY_RE = re.compile(
    r"(key|token|secret|password|passwd|dsn|database_url|encryption|private|gx10|openai|aws_|azure)",
    re.I,
)
CANDIDATE_ACTIONS = frozenset(
    {
        "replace-existing-bind",
        "add-bind-over-image",
        "add-bind-absent-path",
    }
)
SKIP_ACTION = "skip-unchanged-image"
PINNED_WORKER_IMAGE = "sha256:47d3423567b35333059f9ff55817c03656a43431539f0478e3eb959e13e9cdc6"
PINNED_API_IMAGE = "sha256:c500071f5b2fde76d4bfca3ae883afb817c2265e2f113515cdb59c653d469f1f"
EXPECTED_CANDIDATE_BINDS = 37

HARNESS_DEST = "/app/packages/adapters/src/candidate-capture-harness.ts"


def path_norm(value: str) -> str:
    text = (value or "").replace("\\", "/")
    if len(text) > 1 and text.endswith("/"):
        return text[:-1]
    return text


def is_under(dest: str, prefix: str) -> bool:
    dest_n = path_norm(dest)
    prefix_n = path_norm(prefix)
    return dest_n == prefix_n or dest_n.startswith(prefix_n + "/")


def classify_mount(destination: str, source: str = "") -> tuple[str, str]:
    dest = path_norm(destination)
    if not dest:
        return "deny", "empty-dest"
    if dest.endswith(".env"):
        return "deny", "env-file"
    for prefix in STATE_PREFIXES:
        if is_under(dest, prefix):
            return "deny", f"state:{prefix}"
    parts = [part for part in dest.split("/") if part]
    for part in parts:
        if part in STATE_COMPONENTS:
            return "deny", f"state-component:{part}"
    if dest == APP_PREFIX or dest.startswith(APP_PREFIX + "/"):
        return "allow", "app-source"
    return "deny", "not-app-source"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_env_policy(bundle: Path) -> dict[str, str]:
    policy: dict[str, str] = {}
    path = bundle / "allowlisted-env.txt"
    sibling = bundle.parent / "isolated-capture" / "allowlisted-env.txt"
    if not path.exists() and sibling.exists():
        path = sibling
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


def parse_typed_value(kind: str, value: str) -> tuple[bool, str | None]:
    text = value.strip()
    if kind == "int":
        if INT_RE.fullmatch(text):
            return True, text
        return False, None
    if kind in ZERO_ONE_KINDS:
        if text in ("0", "1"):
            return True, text
        return False, None
    if kind in ("bool", "botdir_switch"):
        mapped = BOOL_VALUES.get(text.lower())
        if mapped is None:
            return False, None
        return True, mapped
    if kind == "default_on_kill_switch":
        if text.lower() in DEFAULT_ON_KILL_SWITCH:
            return True, text
        return False, None
    if kind == "model_list":
        if MODEL_LIST_RE.fullmatch(text) and len(text) <= 200:
            return True, text
        return False, None
    if kind.startswith("enum:"):
        allowed = {item.strip() for item in kind.split(":", 1)[1].split(",") if item.strip()}
        if text in allowed:
            return True, text
        return False, None
    if kind == "model_json":
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return False, None
        if not isinstance(parsed, dict) or len(parsed) > 8:
            return False, None
        cleaned: dict[str, bool] = {}
        for key, item in parsed.items():
            if key not in MODEL_JSON_KEYS:
                return False, None
            if isinstance(item, bool):
                cleaned[key] = item
            else:
                return False, None
        return True, json.dumps(cleaned, separators=(",", ":"), sort_keys=True)
    if kind == "disabled_tool_csv":
        if text == DISABLED_TOOL_CSV:
            return True, text
        return False, None
    if kind == "iana_timezone":
        if IANA_TZ_RE.fullmatch(text) and len(text) <= 64:
            return True, text
        return False, None
    if kind == "never":
        return False, None
    return False, None


def classify_env(env: dict[str, str], policy: dict[str, str]) -> dict[str, object]:
    observed = []
    forwarded: dict[str, str] = {}
    for key, value in sorted(env.items()):
        kind = policy.get(key)
        secretish = bool(SECRET_KEY_RE.search(key))
        record: dict[str, object] = {
            "key": key,
            "present": True,
            "kind": kind or "unlisted",
            "forwarded": False,
            "secretishName": secretish,
        }
        if kind == "never" or key in NEVER_FORWARD:
            record["sha256"] = sha256_text(value)
            record["charLength"] = len(value)
            record["replacedWith"] = "synthetic-unset"
            observed.append(record)
            continue
        if kind is None:
            if not secretish:
                record["omitted"] = True
            observed.append(record)
            continue
        record["sha256"] = sha256_text(value)
        record["charLength"] = len(value)
        ok, cleaned = parse_typed_value(kind, value)
        if ok and cleaned is not None:
            record["forwarded"] = True
            forwarded[key] = cleaned
        else:
            record["rejected"] = "not-typed-known-safe"
        observed.append(record)
    return {"observed": observed, "forwarded": forwarded}


def classify_mounts(mounts: list[dict[str, str]]) -> tuple[list[dict], list[dict]]:
    allowed = []
    skipped = []
    for mount in mounts:
        dest = mount.get("destination") or mount.get("Destination") or ""
        src = mount.get("source") or mount.get("Source") or ""
        rec = {
            "type": mount.get("type") or mount.get("Type"),
            "source": src,
            "destination": path_norm(dest),
            "mode": "ro",
        }
        decision, reason = classify_mount(dest, src)
        if decision == "allow":
            allowed.append(rec)
        else:
            skipped.append({**rec, "reason": reason})
    return allowed, skipped


def docker_security_args() -> list[str]:
    return [
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--cpus",
        CPU_LIMIT,
        "--memory",
        MEMORY_LIMIT,
        "--pids-limit",
        PIDS_LIMIT,
    ]


def run_cmd(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, check=False, capture_output=True, text=True)


def inspect_image(ref: str) -> dict:
    if not ref:
        return {"error": "image ref unset", "local": False}
    try:
        proc = run_cmd(["docker", "image", "inspect", ref])
    except FileNotFoundError:
        return {"error": "docker-unavailable", "local": False, "ref": ref}
    if proc.returncode != 0:
        return {"error": (proc.stderr or "").strip() or "docker image inspect failed", "local": False, "ref": ref}
    info = json.loads(proc.stdout)[0]
    return {
        "ref": ref,
        "local": True,
        "id": info.get("Id"),
        "repoDigests": info.get("RepoDigests") or [],
        "repoTags": info.get("RepoTags") or [],
        "created": info.get("Created"),
    }


def inspect_container(name: str, policy: dict[str, str]) -> dict | None:
    if not name:
        return None
    try:
        proc = run_cmd(["docker", "inspect", name])
    except FileNotFoundError:
        return {"name": name, "error": "docker-unavailable (no exec was attempted)"}
    if proc.returncode != 0:
        return {"name": name, "error": "inspect failed (no exec was attempted)"}
    info = json.loads(proc.stdout)[0]
    env: dict[str, str] = {}
    for item in info.get("Config", {}).get("Env") or []:
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        env[key] = value
    classified = classify_env(env, policy)
    allowed, skipped = classify_mounts(info.get("Mounts") or [])
    return {
        "name": name,
        "id": (info.get("Id") or "")[:12],
        "image": info.get("Image"),
        "envPrivacy": {
            "observed": classified["observed"],
            "forwardedKeys": sorted(classified["forwarded"]),
        },
        "forwardedEnv": classified["forwarded"],
        "sourceMounts": allowed,
        "skippedMounts": skipped,
        "retainedSourceMountCount": len(allowed),
        "skippedMountCount": len(skipped),
    }


def load_compose_override(overlay: Path) -> list[dict[str, str]]:
    path = overlay / "COMPOSE-OVERRIDE.tsv"
    if not path.is_file():
        raise SystemExit(f"missing {path}")
    lines = path.read_text().splitlines()
    if not lines:
        raise SystemExit("COMPOSE-OVERRIDE.tsv is empty")
    header = lines[0].split("\t")
    rows = []
    for line in lines[1:]:
        if not line.strip():
            continue
        cols = line.split("\t")
        row = {header[i]: cols[i] if i < len(cols) else "" for i in range(len(header))}
        rows.append(row)
    return rows


def assert_unique_dests(rows: list[dict[str, str]]) -> None:
    seen: dict[tuple[str, str], str] = {}
    for row in rows:
        key = (row["service"], path_norm(row["dest"]))
        if key in seen:
            raise SystemExit(f"duplicate destination {key[0]} {key[1]}")
        seen[key] = row.get("path", "")


def refuse_stage(stage: Path) -> None:
    resolved = stage.resolve()
    text = str(resolved)
    for root in FORBIDDEN_STAGE_ROOTS:
        if is_under(text, root):
            raise SystemExit(f"refusing stage under {root}: {text}")
    if STAGE_MARK not in resolved.parts and STAGE_MARK not in resolved.name:
        raise SystemExit(
            f"stage must be a capture-only directory named *{STAGE_MARK}* (got {text})"
        )


def cleanup_stage(stage: Path) -> int:
    refuse_stage(stage)
    if stage.exists():
        shutil.rmtree(stage)
        print(f"removed capture-only stage {stage}")
    else:
        print(f"stage already absent {stage}")
    return 0


def stage_after_files(overlay: Path, stage: Path, rows: list[dict[str, str]]) -> list[dict[str, str]]:
    refuse_stage(stage)
    stage.mkdir(parents=True, exist_ok=True)
    staged = []
    for row in rows:
        if row["action"] == SKIP_ACTION:
            continue
        rel = row["host_source"]
        if not rel:
            raise SystemExit(f"candidate row missing host_source: {row}")
        src = overlay / rel
        if not src.is_file():
            raise SystemExit(f"missing overlay after file {src}")
        got = sha256_file(src)
        expected = row["after_sha256"]
        if got != expected:
            raise SystemExit(f"after hash mismatch {row['service']} {row['path']}: {got} != {expected}")
        dest = stage / row["service"] / row["path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        if sha256_file(dest) != expected:
            raise SystemExit(f"staged hash mismatch {dest}")
        staged.append(
            {
                **row,
                "staged_source": str(dest),
                "verified_sha256": got,
            }
        )
    return staged


def merge_mounts(
    service: str,
    inspected: list[dict],
    staged_rows: list[dict[str, str]],
    bundle: Path,
    out_dir: Path,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Return (final_mounts, candidate_binds, preserved). Refuse duplicate dests."""
    inspected_by_dest: dict[str, dict] = {}
    for mount in inspected:
        dest = path_norm(mount["destination"])
        if dest in inspected_by_dest:
            raise SystemExit(f"inspect listed destination twice: {service} {dest}")
        inspected_by_dest[dest] = mount

    candidate_by_dest = {
        path_norm(row["dest"]): row for row in staged_rows if row["service"] == service
    }
    seen: set[str] = set()
    final: list[dict] = []
    candidate_binds: list[dict] = []
    preserved: list[dict] = []

    def add(rec: dict, *, candidate: bool) -> None:
        dest = path_norm(rec["destination"])
        if dest in seen:
            raise SystemExit(f"duplicate destination {service} {dest}")
        decision, reason = classify_mount(dest, rec.get("source", ""))
        if decision != "allow" and dest not in ("/opt/candidate-capture", "/out"):
            if dest == "/opt/candidate-capture" or dest == "/out":
                pass
            else:
                raise SystemExit(f"refusing bind {dest}: {reason}")
        seen.add(dest)
        final.append(rec)
        if candidate:
            candidate_binds.append(rec)

    add(
        {
            "source": str(bundle),
            "destination": "/opt/candidate-capture",
            "mode": "ro",
            "action": "bundle",
        },
        candidate=False,
    )
    add(
        {
            "source": str(out_dir),
            "destination": "/out",
            "mode": "rw",
            "action": "output",
        },
        candidate=False,
    )
    harness_src = bundle / "candidate-capture-harness.ts"
    if not harness_src.is_file():
        repo_harness = bundle.parents[3] / "packages/adapters/src/candidate-capture-harness.ts"
        if repo_harness.is_file():
            harness_src = repo_harness
    if not harness_src.is_file():
        raise SystemExit(f"missing {harness_src}")
    add(
        {
            "source": str(harness_src),
            "destination": HARNESS_DEST,
            "mode": "ro",
            "action": "harness-new-dest",
        },
        candidate=False,
    )

    for dest, mount in inspected_by_dest.items():
        if dest == HARNESS_DEST:
            # harness new dest wins; never keep a production file at that path
            continue
        if dest in candidate_by_dest:
            row = candidate_by_dest[dest]
            rec = {
                "source": row["staged_source"],
                "destination": dest,
                "mode": "ro",
                "action": "replace-existing-bind",
                "composeAction": row["action"],
                "path": row["path"],
                "after_sha256": row["after_sha256"],
                "replacedInspectedSource": mount.get("source", ""),
            }
            add(rec, candidate=True)
        else:
            rec = {
                "source": mount.get("source", ""),
                "destination": dest,
                "mode": "ro",
                "action": "preserve-unchanged-mount",
            }
            add(rec, candidate=False)
            preserved.append(rec)

    for dest, row in candidate_by_dest.items():
        if dest in seen:
            continue
        rec = {
            "source": row["staged_source"],
            "destination": dest,
            "mode": "ro",
            "action": row["action"],
            "composeAction": row["action"],
            "path": row["path"],
            "after_sha256": row["after_sha256"],
        }
        add(rec, candidate=True)

    return final, candidate_binds, preserved


def prefix_name(service: str) -> str:
    return f"{PREFIX}-{service}-{os.getpid()}"


def plan_service(
    service: str,
    image_ref: str,
    container_name: str,
    bundle: Path,
    out: Path,
    overlay: Path,
    staged_rows: list[dict[str, str]],
    policy: dict[str, str],
    live: dict | None | str = "inspect",
    pack_sha: str = "",
    git_head: str = "",
) -> dict:
    image = inspect_image(image_ref)
    if live == "inspect":
        live = inspect_container(container_name, policy)
    name = prefix_name(service)
    out_dir = out / service
    out_dir.mkdir(parents=True, exist_ok=True)
    inspected = []
    if live and isinstance(live, dict) and "sourceMounts" in live:
        inspected = list(live["sourceMounts"])
    mounts, candidate_binds, preserved = merge_mounts(
        service, inspected, staged_rows, bundle, out_dir
    )
    env = {
        "ISOLATED_CAPTURE_SERVICE": service,
        "ISOLATED_CAPTURE_OUT": "/out",
        "ISOLATED_CAPTURE_NOW": os.environ.get("ISOLATED_CAPTURE_NOW", "2026-11-07T00:00:00.000Z"),
        "RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS": DISABLED_TOOL_CSV,
        "RAKAZO_DEFAULT_TIMEZONE": os.environ.get("RAKAZO_DEFAULT_TIMEZONE", "America/New_York"),
        "RAKAZO_GUARD_FINAL_SUMMARY": os.environ.get("RAKAZO_GUARD_FINAL_SUMMARY", "1"),
        "RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC": "1",
        "CANDIDATE_PACK_SHA256": pack_sha,
        "CANDIDATE_GIT_HEAD": git_head,
        "CANDIDATE_SERVICE": service,
        "CANDIDATE_CAPTURE_KIND": "composed-executor-piruntime-stub-sse",
    }
    if live and isinstance(live, dict):
        env.update(live.get("forwardedEnv") or {})
        env.setdefault("RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS", DISABLED_TOOL_CSV)
        env.setdefault("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "1")
    if image.get("id"):
        env[f"RAKAZO_{service.upper()}_IMAGE_ID"] = str(image["id"])
    cmd = [
        "docker",
        "run",
        "--name",
        name,
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,exec,nosuid,size=256m",
        "--tmpfs",
        "/run:rw,nosuid,size=16m",
        "--workdir",
        "/app",
        "--entrypoint",
        "bash",
        *docker_security_args(),
    ]
    for mount in mounts:
        cmd.extend(["-v", f"{mount['source']}:{mount['destination']}:{mount.get('mode', 'ro')}"])
    for key, value in env.items():
        cmd.extend(["-e", f"{key}={value}"])
    cmd.extend([image_ref or "MISSING_IMAGE", "/opt/candidate-capture/run.sh"])
    live_public = None
    if live and isinstance(live, dict):
        live_public = {k: v for k, v in live.items() if k != "forwardedEnv"}
    return {
        "service": service,
        "containerName": name,
        "image": image,
        "liveInspect": live_public,
        "mounts": mounts,
        "candidateBinds": candidate_binds,
        "preservedMounts": preserved,
        "envKeys": sorted(env),
        "dockerRun": cmd,
        "dockerRunRawForExecute": cmd,
        "gateMet": False,
        "network": "none (in-container loopback stub only)",
        "pull": "never",
        "build": False,
    }


def build_manifest(
    worker: dict,
    api: dict,
    execute: bool,
    overlay: Path,
    pack_sha: str,
    git_head: str,
    staged_rows: list[dict[str, str]],
) -> dict:
    candidate = (worker.get("candidateBinds") or []) + (api.get("candidateBinds") or [])
    file_hashes = [
        {
            "service": row["service"],
            "path": row["path"],
            "dest": row["dest"],
            "action": row["action"],
            "after_sha256": row["after_sha256"],
            "staged_sha256": row.get("verified_sha256"),
        }
        for row in staged_rows
    ]
    return {
        "kind": "candidate-capture-ephemeral",
        "harness": "composed-executor-piruntime-stub-sse",
        "notBaselineAssembler": True,
        "gateMet": False,
        "gx10Calls": 0,
        "network": "none (loopback stub inside container)",
        "pull": "never",
        "build": False,
        "readOnlyRoot": True,
        "capDrop": "ALL",
        "noNewPrivileges": True,
        "cpus": CPU_LIMIT,
        "memory": MEMORY_LIMIT,
        "pidsLimit": PIDS_LIMIT,
        "productionUntouched": True,
        "noStateOrSecretsMounts": True,
        "noEnvCopy": True,
        "candidateOverlay": str(overlay),
        "packSha256": pack_sha,
        "gitHead": git_head,
        "pinnedImages": {"worker": PINNED_WORKER_IMAGE, "api": PINNED_API_IMAGE},
        "candidateBindCount": len(candidate),
        "expectedCandidateBindCount": EXPECTED_CANDIDATE_BINDS,
        "candidateBinds": [
            {
                "service": plan["service"],
                "destination": row["destination"],
                "action": row["action"],
                "composeAction": row.get("composeAction"),
                "after_sha256": row.get("after_sha256"),
                "source": row["source"],
            }
            for plan in (worker, api)
            for row in plan.get("candidateBinds") or []
        ],
        "fileHashes": file_hashes,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "execute": execute,
        "services": [
            {k: v for k, v in worker.items() if k != "dockerRunRawForExecute"},
            {k: v for k, v in api.items() if k != "dockerRunRawForExecute"},
        ],
        "syntheticScenarios": [
            "generated-secret",
            "stale-secret",
            "protected-handoff-repaired-path",
            "false-success-done",
            "compaction-current-secret",
            "compaction-stale-secret",
        ],
        "handoffLabel": (
            "Preimage has no protected handle; empty fail-before handoff is an invariant, "
            "not leak proof. AFTER handoff is the repaired path."
        ),
        "stagingCleanup": f"--cleanup-stage against a *{STAGE_MARK}* directory only",
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="candidate_launch.py")
    parser.add_argument("--bundle")
    parser.add_argument("--candidate-overlay")
    parser.add_argument("--stage")
    parser.add_argument("--out")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--cleanup-stage", action="store_true")
    parser.add_argument("--pack-sha256", default="")
    parser.add_argument("--git-head", default="")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.cleanup_stage:
        if not args.stage:
            print("--stage is required for --cleanup-stage", file=sys.stderr)
            return 2
        return cleanup_stage(Path(args.stage))
    if not args.bundle or not args.candidate_overlay or not args.stage or not args.out:
        print("bundle, candidate-overlay, stage, and out are required", file=sys.stderr)
        return 2
    execute = bool(args.execute) and not args.dry_run
    bundle = Path(args.bundle).resolve()
    overlay = Path(args.candidate_overlay).resolve()
    stage = Path(args.stage)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    rows = load_compose_override(overlay)
    assert_unique_dests(rows)
    candidate_rows = [row for row in rows if row["action"] in CANDIDATE_ACTIONS]
    if len(candidate_rows) != EXPECTED_CANDIDATE_BINDS:
        raise SystemExit(
            f"COMPOSE-OVERRIDE candidate binds {len(candidate_rows)} != {EXPECTED_CANDIDATE_BINDS}"
        )
    pack_sha = args.pack_sha256 or os.environ.get("CANDIDATE_PACK_SHA256", "")
    git_head = args.git_head or os.environ.get("CANDIDATE_GIT_HEAD", "")
    head_file = overlay / "HEAD.txt"
    if not git_head and head_file.is_file():
        git_head = head_file.read_text().strip()
    sha_file = overlay / "PACK.sha256"
    if not pack_sha and sha_file.is_file():
        pack_sha = sha_file.read_text().split()[0]
    staged_rows = stage_after_files(overlay, stage, candidate_rows)
    policy = load_env_policy(bundle)
    worker = plan_service(
        "worker",
        os.environ.get("RAKAZO_WORKER_IMAGE", PINNED_WORKER_IMAGE),
        os.environ.get("RAKAZO_WORKER_CONTAINER", ""),
        bundle,
        out,
        overlay,
        staged_rows,
        policy,
        pack_sha=pack_sha,
        git_head=git_head,
    )
    api = plan_service(
        "api",
        os.environ.get("RAKAZO_API_IMAGE", PINNED_API_IMAGE),
        os.environ.get("RAKAZO_API_CONTAINER", ""),
        bundle,
        out,
        overlay,
        staged_rows,
        policy,
        pack_sha=pack_sha,
        git_head=git_head,
    )
    combined = len(worker["candidateBinds"]) + len(api["candidateBinds"])
    if combined != EXPECTED_CANDIDATE_BINDS:
        raise SystemExit(f"planned candidate binds {combined} != {EXPECTED_CANDIDATE_BINDS}")
    manifest = build_manifest(worker, api, execute, overlay, pack_sha, git_head, staged_rows)
    (out / "dry-run-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    binds_tsv = ["service\tdest\taction\tcomposeAction\tafter_sha256\tsource"]
    for row in manifest["candidateBinds"]:
        binds_tsv.append(
            "\t".join(
                [
                    row["service"],
                    row["destination"],
                    row["action"],
                    str(row.get("composeAction") or ""),
                    str(row.get("after_sha256") or ""),
                    row["source"],
                ]
            )
        )
    (out / "candidate-binds.tsv").write_text("\n".join(binds_tsv) + "\n")
    print(out / "dry-run-manifest.json")
    print(f"candidate binds: {combined}")
    for row in manifest["candidateBinds"]:
        print(f"{row['service']}\t{row['action']}\t{row['destination']}")
    if not execute:
        print("dry-run only; re-run with --execute under approval")
        return 0
    if not worker["image"].get("local") or not api["image"].get("local"):
        print("refusing execute: both images must exist locally (no pull)", file=sys.stderr)
        return 1
    for plan in (worker, api):
        live = plan.get("liveInspect") or {}
        if live.get("error"):
            print(f"refusing execute: inspect failed for {plan['service']}: {live['error']}", file=sys.stderr)
            return 1
        replace = [row for row in plan["candidateBinds"] if row["action"] == "replace-existing-bind"]
        compose_replace = [
            row
            for row in staged_rows
            if row["service"] == plan["service"] and row["action"] == "replace-existing-bind"
        ]
        if len(replace) < len(compose_replace):
            print(
                f"refusing execute: {plan['service']} replace-existing-bind dest missing from inspect",
                file=sys.stderr,
            )
            return 1
    started = []
    try:
        for plan in (worker, api):
            cmd = plan["dockerRunRawForExecute"]
            print("starting", plan["containerName"])
            proc = subprocess.run(cmd)
            started.append(plan["containerName"])
            if proc.returncode != 0:
                return proc.returncode
    finally:
        for name in started:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
