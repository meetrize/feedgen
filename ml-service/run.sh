#!/bin/bash
# FeedGen ML Sidecar 启动脚本
# 复用 keyatten miniconda 环境，不对公网暴露（仅 127.0.0.1 / 内网）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

KEYATTEN_VENV="${KEYATTEN_VENV:-/www/wwwroot/keyatten/miniconda}"
PYTHON="${KEYATTEN_VENV}/bin/python"
PIP="${KEYATTEN_VENV}/bin/pip"

if [[ ! -x "$PYTHON" ]]; then
  echo "错误: 未找到 keyatten Python 环境: $KEYATTEN_VENV" >&2
  exit 1
fi

if [[ -z "${ML_SERVICE_TOKEN:-}" ]]; then
  echo "错误: 请设置环境变量 ML_SERVICE_TOKEN" >&2
  exit 1
fi

# 仅安装 FastAPI 栈（不重复安装 torch/transformers）
if ! "$PYTHON" -c "import fastapi, uvicorn" 2>/dev/null; then
  echo "正在安装 ml-service 补充依赖..."
  "$PIP" install -r requirements.txt -q
fi

export ML_SERVICE_PORT="${ML_SERVICE_PORT:-3010}"
export ML_MODELS_DIR="${ML_MODELS_DIR:-$ROOT/models}"
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"

mkdir -p "$ML_MODELS_DIR"

echo "启动 ML 服务 :${ML_SERVICE_PORT}（gte-small-zh 懒加载）"
exec "$PYTHON" -m uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "$ML_SERVICE_PORT" \
  --workers 1
