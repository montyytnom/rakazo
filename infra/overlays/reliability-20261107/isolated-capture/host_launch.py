#!/usr/bin/env python3
"""Ephemeral isolated-capture launcher. Inspect-only of production; no exec/mutation."""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

PREFIX = "rakazo-isolated-capture"
APP_PREFIX = "/app"
STATE_PREFIXES = (
    "/data",
    "/run/login-guard",
    "/run/op-data",
    "/run/secrets",
    "/var/lib",
)
STATE_COMPONENTS = frozenset({"appdata", "postgres", "postgresql", "redis"})
MODEL_LIST_RE = re.compile(r"^[A-Za-z0-9._,+-]+$")
INT_RE = re.compile(r"^-?\d{1,12}$")
BOOL_VALUES = {"0": "0", "1": "1", "true": "true", "false": "false"}
# Observed chat_template_kwargs keys are booleans. thinking_budget is a top-level env/body field.
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
    """Return (allow|deny, reason). Never substring-match code filenames."""
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


def load_env_policy(bundle: Path) -> dict[str, str]:
    policy: dict[str, str] = {}
    path = bundle / "allowlisted-env.txt"
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


def load_isolated_sources(bundle: Path) -> list[dict[str, str]]:
    rows = []
    path = bundle / "isolated-sources.txt"
    if not path.exists():
        rows.append(
            {
                "source": str(bundle / "isolated-capture.ts"),
                "destination": "/app/packages/adapters/src/isolated-capture.ts",
                "mode": "ro",
            }
        )
        return rows
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        rel, dest = line.split("\t", 1)
        src = bundle / rel.strip()
        if not src.exists() and rel.strip() == "isolated-capture.ts":
            repo = bundle.parents[3] / "packages" / "adapters" / "src" / "isolated-capture.ts"
            if repo.exists():
                src = repo
        rows.append({"source": str(src), "destination": dest.strip(), "mode": "ro"})
    return rows


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
    return {
        "observed": observed,
        "forwarded": forwarded,
        "typedAssistSwitches": {
            "RAKAZO_ASSIST_PROMPT": "off_when_0",
            "RAKAZO_ASSIST_STABLE_PREFIX": "off_when_0",
            "note": "source compares === \"0\"; live both-services value 1 is forwarded literally. Freeform text is rejected, not treated as prompt.",
        },
        "normalization": [
            "RAKAZO_ASSIST_PROMPT and RAKAZO_ASSIST_STABLE_PREFIX are boolean 0/1 switches (source === \"0\"), forwarded literally when 0 or 1",
            "chat_template_kwargs known boolean fields: enable_thinking, medium_effort",
            "only typed known-safe scalars may be forwarded; unexplained consumed env blocks preflight",
        ],
    }


def classify_mounts(mounts: list[dict[str, str]]) -> tuple[list[dict], list[dict]]:
    allowed = []
    skipped = []
    for mount in mounts:
        dest = mount.get("destination") or mount.get("Destination") or ""
        src = mount.get("source") or mount.get("Source") or ""
        rec = {
            "type": mount.get("type") or mount.get("Type"),
            "source": src,
            "destination": dest,
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
            "typedAssistSwitches": classified["typedAssistSwitches"],
            "normalization": classified["normalization"],
        },
        "forwardedEnv": classified["forwarded"],
        "sourceMounts": allowed,
        "skippedMounts": skipped,
        "retainedSourceMountCount": len(allowed),
        "skippedMountCount": len(skipped),
    }


def redact_docker_run(cmd: list[str]) -> list[str]:
    """Keep typed 0/1 assist switches visible; never echo rejected freeform values."""
    return list(cmd)


def plan_service(
    service: str,
    image_ref: str,
    container_name: str,
    bundle: Path,
    out: Path,
    policy: dict[str, str],
    live: dict | None | str = "inspect",
) -> dict:
    image = inspect_image(image_ref)
    if live == "inspect":
        live = inspect_container(container_name, policy)
    name = f"{prefix_name(service)}"
    out_dir = str(out / service)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    mounts = [
        {"source": str(bundle), "destination": "/opt/isolated-capture", "mode": "ro"},
        {"source": out_dir, "destination": "/out", "mode": "rw"},
    ]
    mounts.extend(load_isolated_sources(bundle))
    if live and isinstance(live, dict) and "sourceMounts" in live:
        mounts.extend(live["sourceMounts"])
    env = {
        "ISOLATED_CAPTURE_SERVICE": service,
        "ISOLATED_CAPTURE_OUT": "/out",
        "ISOLATED_CAPTURE_NOW": os.environ.get("ISOLATED_CAPTURE_NOW", "2026-11-07T00:00:00.000Z"),
    }
    if live and isinstance(live, dict):
        env.update(live.get("forwardedEnv") or {})
    cmd = [
        "docker",
        "run",
        "--name",
        name,
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
        if key in NEVER_FORWARD:
            continue
        cmd.extend(["-e", f"{key}={value}"])
    cmd.extend([image_ref or "MISSING_IMAGE", "/opt/isolated-capture/run.sh"])
    live_public = None
    if live and isinstance(live, dict):
        live_public = {k: v for k, v in live.items() if k != "forwardedEnv"}
    return {
        "service": service,
        "containerName": name,
        "image": image,
        "liveInspect": live_public,
        "mounts": mounts,
        "envKeys": sorted(env),
        "dockerRun": redact_docker_run(cmd),
        "dockerRunRawForExecute": cmd,
        "gateMet": False,
    }


def prefix_name(service: str) -> str:
    return f"{PREFIX}-{service}-{os.getpid()}"


def build_manifest(worker: dict, api: dict, execute: bool, coverage: dict | None = None) -> dict:
    return {
        "kind": "isolated-capture-ephemeral",
        "gateMet": False,
        "gx10Calls": 0,
        "network": "none (loopback stub inside container)",
        "pull": "never",
        "readOnlyRoot": True,
        "capDrop": "ALL",
        "noNewPrivileges": True,
        "cpus": CPU_LIMIT,
        "memory": MEMORY_LIMIT,
        "pidsLimit": PIDS_LIMIT,
        "productionUntouched": True,
        "noEnvCopy": True,
        "noAssistPromptCopy": True,
        "assistSwitchesForwarded": "off_when_0 literal 0/1",
        "noLoginGuardPolicyMount": True,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "execute": execute,
        "services": [
            {k: v for k, v in worker.items() if k != "dockerRunRawForExecute"},
            {k: v for k, v in api.items() if k != "dockerRunRawForExecute"},
        ],
        "volatileFieldsNote": "byte-diff full body after declared volatile fields",
        "assistNormalization": "RAKAZO_ASSIST_PROMPT / RAKAZO_ASSIST_STABLE_PREFIX are source === \"0\" switches; live 1 is forwarded. Freeform text is rejected.",
        "chatTemplateKwargsKnownFields": sorted(MODEL_JSON_KEYS),
        "configCoverage": {
            "ok": bool(coverage and coverage.get("ok")),
            "unexplained": (coverage or {}).get("unexplained") or [],
            "explicitOmitted": (coverage or {}).get("explicitOmitted") or [],
        },
    }


def main(argv: list[str]) -> int:
    bundle = Path(argv[0]).resolve()
    out = Path(argv[1]).resolve()
    execute = argv[2] == "1"
    out.mkdir(parents=True, exist_ok=True)
    import config_coverage

    coverage = config_coverage.preflight(
        bundle,
        model_json_keys=MODEL_JSON_KEYS,
        never_forward=NEVER_FORWARD,
    )
    (out / "config-coverage-preflight.json").write_text(json.dumps(coverage, indent=2) + "\n")
    if not coverage["ok"]:
        print("config-coverage preflight blocked", file=sys.stderr)
        print(json.dumps(coverage, indent=2), file=sys.stderr)
        return 2
    policy = load_env_policy(bundle)
    worker = plan_service(
        "worker",
        os.environ.get("RAKAZO_WORKER_IMAGE", ""),
        os.environ.get("RAKAZO_WORKER_CONTAINER", ""),
        bundle,
        out,
        policy,
    )
    api = plan_service(
        "api",
        os.environ.get("RAKAZO_API_IMAGE", ""),
        os.environ.get("RAKAZO_API_CONTAINER", ""),
        bundle,
        out,
        policy,
    )
    manifest = build_manifest(worker, api, execute, coverage)
    (out / "dry-run-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(out / "dry-run-manifest.json")
    if not execute:
        print("dry-run only; re-run with --execute under approval")
        return 0
    if not worker["image"].get("local") or not api["image"].get("local"):
        print("refusing execute: both images must exist locally (no pull)", file=sys.stderr)
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
