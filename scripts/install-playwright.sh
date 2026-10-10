#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
DEST=/opt/feedgen
cd "$DEST/backend"

# 清理上次中断留下的锁
rm -rf /root/.cache/ms-playwright/__dirlock 2>/dev/null || true

# Windows Clash 代理（若可用）
if curl -sS -m 2 -o /dev/null http://127.0.0.1:7890 >/dev/null 2>&1; then
  export http_proxy=http://127.0.0.1:7890
  export https_proxy=http://127.0.0.1:7890
  export HTTP_PROXY=$http_proxy
  export HTTPS_PROXY=$https_proxy
  echo ">>> 使用代理 $http_proxy"
fi

echo ">>> 系统依赖与中文字体..."
apt-get update -qq
apt-get install -y -qq fonts-noto-cjk fonts-wqy-microhei fonts-liberation \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2t64 libpango-1.0-0 libcairo2 libatspi2.0-0t64 libgtk-3-0t64 \
  >/dev/null || apt-get install -y -qq fonts-noto-cjk fonts-wqy-microhei \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 libgtk-3-0 >/dev/null
fc-cache -f >/dev/null 2>&1 || true

echo ">>> Playwright Chromium..."
unset PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
npx --yes playwright install-deps chromium 2>/dev/null || true
npx --yes playwright install chromium

CHROME=$(find /root/.cache/ms-playwright \( -path '*/chrome-linux64/chrome' -o -path '*/chrome-linux/chrome' \) -type f 2>/dev/null | head -1 || true)
if [[ -z "${CHROME:-}" || ! -x "$CHROME" ]]; then
  echo "错误: 未找到 Chromium" >&2
  find /root/.cache/ms-playwright -maxdepth 4 -type f -name chrome 2>/dev/null || true
  ls -la /root/.cache/ms-playwright 2>/dev/null || true
  exit 1
fi
chmod +x "$CHROME"
echo "Chromium: $CHROME"
"$CHROME" --version || true

for ENVF in "$DEST/scripts/feedgen.env" "$DEST/backend/.env" /mnt/c/pro/feedgen/backend/.env; do
  [[ -f "$ENVF" ]] || continue
  if grep -q '^PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=' "$ENVF"; then
    sed -i "s|^PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=.*|PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$CHROME|" "$ENVF"
  else
    echo "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$CHROME" >> "$ENVF"
  fi
done

echo ">>> 启动验证..."
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$CHROME" node <<'NODE'
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto('https://example.com', { timeout: 30000 });
  console.log('OK:', await page.title());
  await browser.close();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
NODE

echo ">>> 重启后端..."
feedgen restart backend
sleep 5
feedgen status
echo "Playwright 安装完成: $CHROME"
