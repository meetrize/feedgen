#!/usr/bin/env bash
# GitHub HTTPS 登录：将 Personal Access Token 写入 git 凭据存储
# 用法：GH_TOKEN=ghp_你的token bash scripts/github-login.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "请设置环境变量 GH_TOKEN（GitHub → Settings → Developer settings → Personal access tokens）"
  echo "示例：GH_TOKEN=ghp_xxxx bash scripts/github-login.sh"
  exit 1
fi

# 代理：SOCKS5 优于 HTTP（CentOS7 下 git+curl 走 7890 易 EOF）
git config --global http.proxy socks5://127.0.0.1:7891
git config --global https.proxy socks5://127.0.0.1:7891
git config --global http.https://github.com/.proxy socks5://127.0.0.1:7891
git config --global --unset-all http.https://github.com/.extraheader 2>/dev/null || true
git config --global credential.helper 'store --file=/root/.git-credentials'

# 凭据格式：https://用户名:token@github.com
# 推送时用户名可填 GitHub 用户名或字面量 x-access-token
GITHUB_USER="${GITHUB_USER:-meetrize}"
printf 'protocol=https\nhost=github.com\nusername=%s\npassword=%s\n\n' "$GITHUB_USER" "$GH_TOKEN" \
  | git credential approve

chmod 600 /root/.git-credentials 2>/dev/null || true

echo "正在验证 GitHub 连接…"
if ! git ls-remote origin HEAD >/dev/null 2>&1; then
  echo "连接失败。请在 Clash 面板将「🔰 选择节点」切到「🇺🇲 美国A01」等可访问 GitHub 的节点后重试。"
  exit 1
fi

echo "凭据已保存。可执行：git push origin main"
