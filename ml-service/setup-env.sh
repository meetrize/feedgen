#!/bin/bash
# 自动安装 ML 服务 Python 环境（keyatten 不可用时使用本地 miniforge/miniconda）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

MINICONDA_DIR="${ML_MINICONDA_DIR:-$ROOT/miniconda}"
MINICONDA_INSTALLER="/tmp/miniforge-feedgen-ml.sh"

# 外网下载走本地代理（如 clash/v2ray 默认 7890）
if [[ -z "${http_proxy:-}" && -z "${HTTP_PROXY:-}" ]]; then
  if curl -fsS --connect-timeout 2 http://127.0.0.1:7890 >/dev/null 2>&1 || \
     nc -z 127.0.0.1 7890 2>/dev/null; then
    export http_proxy=http://127.0.0.1:7890
    export https_proxy=http://127.0.0.1:7890
    echo "使用代理: $http_proxy"
  fi
fi

resolve_python() {
  local keyatten="${KEYATTEN_VENV:-/www/wwwroot/keyatten/miniconda}"
  if [[ -x "$keyatten/bin/python" ]]; then
    echo "$keyatten/bin/python"
    return 0
  fi
  if [[ -x "$MINICONDA_DIR/bin/python" ]]; then
    echo "$MINICONDA_DIR/bin/python"
    return 0
  fi
  return 1
}

install_miniconda() {
  if [[ -x "$MINICONDA_DIR/bin/python" ]]; then
    echo "本地 Python 环境已存在: $MINICONDA_DIR"
    return 0
  fi

  echo "正在下载 Miniforge（Python 3.11）..."
  curl -fsSL -L \
    "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh" \
    -o "$MINICONDA_INSTALLER"

  echo "正在安装到 $MINICONDA_DIR ..."
  bash "$MINICONDA_INSTALLER" -b -p "$MINICONDA_DIR"
  rm -f "$MINICONDA_INSTALLER"
}

install_deps() {
  local python pip
  python="$(resolve_python)"
  pip="${python%python}pip"

  echo "使用 Python: $python ($("$python" --version))"

  echo "升级 pip..."
  "$pip" install -U pip wheel setuptools -q

  echo "安装 PyTorch（CPU）..."
  "$pip" install torch --index-url https://download.pytorch.org/whl/cpu -q

  echo "安装 numpy / scikit-learn（conda 预编译包）..."
  "${python%python}conda" install -y -c conda-forge numpy scikit-learn joblib -q

  echo "安装 transformers..."
  "$pip" install "transformers>=4.38,<5" -q

  echo "安装 ml-service 依赖..."
  "$pip" install -r requirements.txt -q

  echo "验证依赖..."
  "$python" -c "import fastapi, uvicorn, sklearn, joblib, torch, transformers, numpy; print('依赖检查通过:', 'torch', torch.__version__, 'transformers', transformers.__version__)"
}

install_miniconda
install_deps

echo ""
echo "ML 环境安装完成。启动服务："
echo "  export ML_SERVICE_TOKEN=<与 backend/.env 一致>"
echo "  ./run.sh"
