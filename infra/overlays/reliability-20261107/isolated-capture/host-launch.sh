#!/usr/bin/env bash
# Create ephemeral api/worker capture containers from LOCAL image digests.
# Default is dry-run. Pass --execute under approval to start containers.
# Never pulls/builds, never execs/patches/restarts production, never copies .env
# or login-guard policy, never mounts appdata/secrets/DB/browser/session.
set -euo pipefail
BUNDLE="$(cd "$(dirname "$0")" && pwd)"
EXECUTE=0
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --dry-run) EXECUTE=0; shift ;;
    --out) OUT="${2:?}"; shift 2 ;;
    -h|--help)
      echo "usage: $0 [--dry-run|--execute] --out DIR"
      echo "env: RAKAZO_WORKER_IMAGE RAKAZO_API_IMAGE (local digest or id, --pull=never)"
      echo "optional inspect-only: RAKAZO_WORKER_CONTAINER RAKAZO_API_CONTAINER"
      exit 0
      ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$OUT" ]]; then
  echo "--out DIR is required" >&2
  exit 2
fi
mkdir -p "$OUT"
export BUNDLE OUT
export RAKAZO_WORKER_IMAGE="${RAKAZO_WORKER_IMAGE:-}"
export RAKAZO_API_IMAGE="${RAKAZO_API_IMAGE:-}"
export RAKAZO_WORKER_CONTAINER="${RAKAZO_WORKER_CONTAINER:-}"
export RAKAZO_API_CONTAINER="${RAKAZO_API_CONTAINER:-}"
export ISOLATED_CAPTURE_NOW="${ISOLATED_CAPTURE_NOW:-2026-11-07T00:00:00.000Z}"

python3 - "$BUNDLE" "$OUT" "$EXECUTE" <<'PY'
import json, os, re, subprocess, sys, datetime
from pathlib import Path

bundle, out, execute = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3] == "1"
allow = [line.strip() for line in (bundle / "allowlisted-env.txt").read_text().splitlines() if line.strip() and not line.startswith("#")]
allow_set = set(allow)
deny_mount = re.compile(
    r"appdata|/secrets?(?:/|$)|/\.env$|\.env$|/login-guard|/postgres|/redis|chrome|session|/var/lib",
    re.I,
)
secret_key = re.compile(r"(key|token|secret|password|passwd|dsn|database_url|encryption|private|gx10|openai|aws_|azure)", re.I)
prefix = "rakazo-isolated-capture"

def run(cmd):
    return subprocess.run(cmd, check=False, capture_output=True, text=True)

def inspect_image(ref):
    if not ref:
        return {"error": "image ref unset", "local": False}
    proc = run(["docker", "image", "inspect", ref])
    if proc.returncode != 0:
        return {"error": proc.stderr.strip() or "docker image inspect failed", "local": False, "ref": ref}
    info = json.loads(proc.stdout)[0]
    digests = info.get("RepoDigests") or []
    return {
        "ref": ref,
        "local": True,
        "id": info.get("Id"),
        "repoDigests": digests,
        "created": info.get("Created"),
    }

def inspect_container(name):
    if not name:
        return None
    proc = run(["docker", "inspect", name])
    if proc.returncode != 0:
        return {"name": name, "error": "inspect failed (no exec was attempted)"}
    info = json.loads(proc.stdout)[0]
    env_pairs = info.get("Config", {}).get("Env") or []
    env = {}
    for item in env_pairs:
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        env[key] = value
    extracted = {k: env[k] for k in allow if k in env}
    omitted = sorted(k for k in env if k not in allow_set)
    omitted_secretish = [k for k in omitted if secret_key.search(k)]
    mounts = []
    skipped = []
    for mount in info.get("Mounts") or []:
        dest = mount.get("Destination") or ""
        src = mount.get("Source") or ""
        rec = {
            "type": mount.get("Type"),
            "source": src,
            "destination": dest,
            "mode": "ro",
        }
        blob = f"{src} {dest}"
        if deny_mount.search(blob) or dest.endswith(".env") or "/run/login-guard" in dest:
            skipped.append({**rec, "reason": "excluded-appdata-secret-env-policy-db-browser-session"})
            continue
        if not dest.startswith("/app/"):
            skipped.append({**rec, "reason": "not-app-source"})
            continue
        mounts.append(rec)
    return {
        "name": name,
        "id": info.get("Id", "")[:12],
        "image": info.get("Image"),
        "extractedAllowlistedEnvKeys": sorted(extracted),
        "extractedAllowlistedEnv": extracted,
        "omittedEnvKeyCount": len(omitted),
        "omittedEnvKeys": omitted,
        "omittedSecretishKeyNamesOnly": omitted_secretish,
        "sourceMounts": mounts,
        "skippedMounts": skipped,
    }

def plan_service(service, image_ref, container_name):
    image = inspect_image(image_ref)
    live = inspect_container(container_name)
    name = f"{prefix}-{service}-{os.getpid()}"
    out_dir = str(out / service)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    mounts = [
        {"source": str(bundle / "isolated-capture.ts"), "destination": "/app/packages/adapters/src/isolated-capture.ts", "mode": "ro"},
        {"source": str(bundle), "destination": "/opt/isolated-capture", "mode": "ro"},
        {"source": out_dir, "destination": "/out", "mode": "rw"},
    ]
    if live and "sourceMounts" in live:
        mounts.extend(live["sourceMounts"])
    env = {
        "ISOLATED_CAPTURE_SERVICE": service,
        "ISOLATED_CAPTURE_OUT": "/out",
        "ISOLATED_CAPTURE_NOW": os.environ.get("ISOLATED_CAPTURE_NOW", "2026-11-07T00:00:00.000Z"),
    }
    if live and live.get("extractedAllowlistedEnv"):
        env.update(live["extractedAllowlistedEnv"])
    harness_src = bundle / "isolated-capture.ts"
    if not harness_src.exists():
        repo_src = bundle.parents[3] / "packages" / "adapters" / "src" / "isolated-capture.ts"
        if repo_src.exists():
            mounts[0]["source"] = str(repo_src)
    cmd = [
        "docker", "run", "--name", name, "--pull=never", "--network", "none",
        "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=256m",
        "--tmpfs", "/run:rw,nosuid,size=16m",
        "--workdir", "/app",
        "--entrypoint", "bash",
    ]
    for mount in mounts:
        cmd.extend(["-v", f"{mount['source']}:{mount['destination']}:{mount.get('mode', 'ro')}"])
    for key, value in env.items():
        cmd.extend(["-e", f"{key}={value}"])
    cmd.extend([image_ref or "MISSING_IMAGE", "/opt/isolated-capture/run.sh"])
    return {
        "service": service,
        "containerName": name,
        "image": image,
        "liveInspect": live,
        "mounts": mounts,
        "envKeys": sorted(env),
        "dockerRun": cmd,
    }

worker = plan_service("worker", os.environ.get("RAKAZO_WORKER_IMAGE"), os.environ.get("RAKAZO_WORKER_CONTAINER"))
api = plan_service("api", os.environ.get("RAKAZO_API_IMAGE"), os.environ.get("RAKAZO_API_CONTAINER"))
manifest = {
    "kind": "isolated-capture-ephemeral",
    "gateMet": False,
    "gx10Calls": 0,
    "network": "none (loopback stub inside container)",
    "pull": "never",
    "readOnlyRoot": True,
    "productionUntouched": True,
    "noEnvCopy": True,
    "noLoginGuardPolicyMount": True,
    "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "execute": execute,
    "services": [worker, api],
    "volatileFieldsNote": "byte-diff full body after declared volatile fields",
}
(out / "dry-run-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(out / "dry-run-manifest.json")
if not execute:
    print("dry-run only; re-run with --execute under approval")
    sys.exit(0)
if not worker["image"].get("local") or not api["image"].get("local"):
    print("refusing execute: both images must exist locally (no pull)", file=sys.stderr)
    sys.exit(1)
started = []
try:
    for plan in (worker, api):
        cmd = plan["dockerRun"]
        print("starting", plan["containerName"])
        proc = subprocess.run(cmd)
        started.append(plan["containerName"])
        if proc.returncode != 0:
            raise SystemExit(proc.returncode)
finally:
    for name in started:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
PY
