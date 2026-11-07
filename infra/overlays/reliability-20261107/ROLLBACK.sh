#!/usr/bin/env bash
set -euo pipefail
BACKUP="${1:?backup directory from ACTIVE-BUNDLE.log}"
if [[ ! -d "$BACKUP" ]]; then
  echo "missing backup dir" >&2
  exit 1
fi
echo "Restore mounted files and the compose chain from $BACKUP, then recreate only the target service with that service's full -f chain. Do not use --remove-orphans or prune."
echo "Example: docker compose -p rakazo $(cat "$BACKUP"/COMPOSE-ARGS.txt) up -d --no-deps worker"
exit 0
