#!/usr/bin/env bash
# 将 Clash「选择节点」切到美国节点，改善 GitHub TLS/EOF 问题
set -euo pipefail

SECRET="${CLASH_SECRET:-}"
if [[ -z "$SECRET" && -f /root/clashctl/resources/mixin.yaml ]]; then
  SECRET="$(grep -m1 '^secret:' /root/clashctl/resources/mixin.yaml | awk '{print $2}')"
fi
if [[ -z "$SECRET" ]]; then
  echo "请设置 CLASH_SECRET 或确保 /root/clashctl/resources/mixin.yaml 含 secret"
  exit 1
fi
GROUP='🔰 选择节点'
NODE="${CLASH_GITHUB_NODE:-🇺🇲 美国A01 | IEPL | x1.5}"

python3 - "$SECRET" "$GROUP" "$NODE" <<'PY'
import json, sys, urllib.request, urllib.parse
secret, group, node = sys.argv[1:4]
url = 'http://127.0.0.1:9090/proxies/' + urllib.parse.quote(group)
body = json.dumps({'name': node}).encode()
req = urllib.request.Request(
    url,
    data=body,
    method='PUT',
    headers={'Authorization': f'Bearer {secret}', 'Content-Type': 'application/json'},
)
with urllib.request.urlopen(req, timeout=10) as r:
    print('已切换节点为:', node)
PY

git config --global http.proxy socks5://127.0.0.1:7891
git config --global https.proxy socks5://127.0.0.1:7891
git config --global http.https://github.com/.proxy socks5://127.0.0.1:7891
echo "Git 代理已设为 socks5://127.0.0.1:7891"
