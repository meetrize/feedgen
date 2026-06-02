#!/usr/bin/env bash
# Sync changed frontend/backend files to the production server and restart services.
# Usage:
#   ./sync-to-server.sh
# Environment overrides:
#   SERVER_HOST, SERVER_USER, SERVER_PASS, SERVER_ROOT, BACKEND_RESTART_CMD, FRONTEND_RESTART_CMD

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

SERVER_HOST="${SERVER_HOST:-123.57.240.125}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_PASS="${SERVER_PASS:-nk7Gh4%k*7l}"
SERVER_ROOT="${SERVER_ROOT:-/www/wwwroot/reader}"
BACKEND_RESTART_CMD="${BACKEND_RESTART_CMD:-feedgen b restart}"
FRONTEND_RESTART_CMD="${FRONTEND_RESTART_CMD:-feedgen f restart}"

SSH_OPTS=(-o StrictHostKeyChecking=no)
SSH_CMD=(sshpass -p "$SERVER_PASS" ssh "${SSH_OPTS[@]}" "${SERVER_USER}@${SERVER_HOST}")
TAR_CREATE_OPTS=(-czf -)
if tar --help 2>/dev/null | grep -q -- '--no-xattrs'; then
  TAR_CREATE_OPTS=(--no-xattrs -czf -)
elif tar --help 2>/dev/null | grep -q -- '--disable-copyfile'; then
  TAR_CREATE_OPTS=(--disable-copyfile -czf -)
fi

CHANGED_FILES=()
while IFS= read -r file; do
  [[ -n "$file" ]] && CHANGED_FILES+=("$file")
done < <(
  {
    git diff --name-only --diff-filter=AM HEAD
    git ls-files --others --exclude-standard
  } | awk '!seen[$0]++'
)

if [[ ${#CHANGED_FILES[@]} -eq 0 ]]; then
  echo "No added or modified files to sync."
  exit 0
fi

backend_files=()
frontend_files=()
other_files=()

for file in "${CHANGED_FILES[@]}"; do
  [[ -f "$file" || -L "$file" ]] || continue
  case "$file" in
    backend/*) backend_files+=("$file") ;;
    frontend/*) frontend_files+=("$file") ;;
    *) other_files+=("$file") ;;
  esac
done

sync_files() {
  local target_dir="$1"
  shift
  local -a files=("$@")
  if [[ ${#files[@]} -eq 0 ]]; then
    return 0
  fi

  printf 'Syncing %s file(s) to %s...\n' "${#files[@]}" "$target_dir"
  "${SSH_CMD[@]}" "mkdir -p '$target_dir'"
  COPYFILE_DISABLE=1 tar "${TAR_CREATE_OPTS[@]}" "${files[@]}" | "${SSH_CMD[@]}" "cd '$target_dir' && tar --warning=no-unknown-keyword -xzf -"
}

if [[ ${#backend_files[@]} -gt 0 ]]; then
  backend_sync_files=()
  for file in "${backend_files[@]}"; do
    backend_sync_files+=("${file#backend/}")
  done
  (cd backend && sync_files "$SERVER_ROOT/backend" "${backend_sync_files[@]}")
fi

if [[ ${#frontend_files[@]} -gt 0 ]]; then
  frontend_sync_files=()
  for file in "${frontend_files[@]}"; do
    frontend_sync_files+=("${file#frontend/}")
  done
  (cd frontend && sync_files "$SERVER_ROOT/frontend" "${frontend_sync_files[@]}")
fi

if [[ ${#other_files[@]} -gt 0 ]]; then
  sync_files "$SERVER_ROOT" "${other_files[@]}"
fi

# if [[ ${#backend_files[@]} -gt 0 ]]; then
#   echo "Restarting backend service..."
#   "${SSH_CMD[@]}" "cd '$SERVER_ROOT' && $BACKEND_RESTART_CMD"
# fi

# if [[ ${#frontend_files[@]} -gt 0 ]]; then
#   echo "Restarting frontend service..."
#   "${SSH_CMD[@]}" "cd '$SERVER_ROOT' && $FRONTEND_RESTART_CMD"
# fi

echo "Done."
