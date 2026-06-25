#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/docker/prune-dev-cache.sh [--limit SIZE] [--deep]

Keeps local Batshit Docker development from accumulating huge BuildKit cache.

Options:
  --limit SIZE  Keep BuildKit cache under SIZE. Default: 8GB.
  --deep        Remove all unused BuildKit cache instead of keeping a warm cache.
  -h, --help    Show this help.

This script prunes Docker build cache and dangling images only. It does not
delete Docker volumes, so Redis/n8n/Batshit persisted container data is left
alone.
EOF
}

limit="${BATSHIT_DOCKER_BUILD_CACHE_LIMIT:-8GB}"
deep=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --limit." >&2
        exit 2
      fi
      limit="$2"
      shift 2
      ;;
    --deep)
      deep=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or is not on PATH." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running or is not reachable." >&2
  exit 1
fi

echo "Docker disk usage before prune:"
docker system df
echo

if [[ "$deep" -eq 1 ]]; then
  echo "Pruning all unused BuildKit cache..."
  docker builder prune --all --force
else
  echo "Pruning BuildKit cache above ${limit}..."
  docker builder prune --force --max-used-space "$limit"
fi

echo
echo "Pruning dangling Docker images..."
docker image prune --force

echo
echo "Docker disk usage after prune:"
docker system df
