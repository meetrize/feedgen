#!/bin/bash
set -euo pipefail

systemctl start postgresql redis-server || true
mkdir -p /opt/feedgen/frontend/css-cache /opt/feedgen/logs

# Ensure prod asset exists
if [[ ! -f /opt/feedgen/backend/dist/utils/youtubePageExtract.browser.js ]]; then
  cd /opt/feedgen/backend
  npm run build
fi

feedgen start
# Wait until both ports answer
for i in $(seq 1 45); do
  be=$(curl -sS -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ 2>/dev/null || true)
  fe=$(curl -sS -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/ 2>/dev/null || true)
  [[ -z "$be" ]] && be=000
  [[ -z "$fe" ]] && fe=000
  echo "try $i be=$be fe=$fe"
  if [[ "$be" != "000" && "$fe" != "000" ]]; then
    curl -sS -m 5 -X POST http://127.0.0.1:3000/api/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"username":"admin","password":"admin123"}' | head -c 140
    echo
    feedgen status
    exit 0
  fi
  sleep 1
done

echo "FAILED to bring services up"
feedgen status
tail -n 40 /opt/feedgen/logs/backend.log || true
tail -n 40 /opt/feedgen/logs/backend.error.log || true
exit 1
