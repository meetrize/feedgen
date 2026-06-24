# FeedGen ML Sidecar

新闻标题 AI 分类的 Python 微服务，监听内网端口，由 Node 后端通过 HTTP 调用。

## 环境

- Python：复用 `/www/wwwroot/keyatten/miniconda`（含 torch、transformers、gte-small-zh）
- 向量模型：`thenlper/gte-small-zh`（CPU，懒加载）
- **不要**对公网暴露 3010 端口；Nginx 不反代此服务

## 启动

```bash
cd /www/wwwroot/pro/ml-service
export ML_SERVICE_TOKEN=your-internal-token
./run.sh
```

可选环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `ML_SERVICE_PORT` | `3010` | 监听端口 |
| `ML_SERVICE_TOKEN` | （必填） | 内部鉴权，Header `X-Internal-Token` |
| `ML_MODELS_DIR` | `./models` | 分类器模型目录（后续步骤使用） |
| `KEYATTEN_VENV` | `/www/wwwroot/keyatten/miniconda` | Python 环境路径 |

## API

| 接口 | 鉴权 | 说明 |
|------|------|------|
| `GET /internal/health` | 无 | 健康检查 |
| `POST /internal/embed` | `X-Internal-Token` | 批量向量 `{ "texts": ["..."] }` |
| `POST /internal/classify` | `X-Internal-Token` | 原型冷启动分类（无 LR 时） |
| `POST /internal/prototype/rebuild` | `X-Internal-Token` | 由示例标题重建原型向量 |

## 验证

```bash
export ML_URL=http://127.0.0.1:3010

curl -s http://127.0.0.1:3010/internal/health

# 重建原型
curl -s -X POST "$ML_URL/internal/prototype/rebuild" \
  -H "Content-Type: application/json" -H "X-Internal-Token: $ML_SERVICE_TOKEN" \
  -d '{"examples":["央行下调存款准备金率","A股收盘上涨","理财产品收益回落"]}'

# 分类（将上一步 prototype 填入 categories）
curl -s -X POST "$ML_URL/internal/classify" \
  -H "Content-Type: application/json" -H "X-Internal-Token: $ML_SERVICE_TOKEN" \
  -d '{"title":"央行宣布下调存款准备金率","categories":[{"id":1,"code":"finance","prototype":[...]}]}'
```

## 当前范围

步骤 3 已实现原型向量冷启动分类；LR 推理与 `train` 在后续步骤实现。
