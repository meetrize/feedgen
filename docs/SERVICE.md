# FeedGen 服务管理

本项目通过 `feedgen` CLI 管理前后端服务（基于 systemd）。**重启、启停、查日志等运维操作一律使用 `feedgen`，不要使用 `restart.sh` 或手动 `npm run dev`。**

命令入口：`/usr/local/bin/feedgen`（源码：`scripts/feedgen`）

## 常用命令

| 命令 | 说明 |
|------|------|
| `feedgen start` | 启动前后端 |
| `feedgen stop` | 停止前后端 |
| `feedgen restart` | 重启前后端 |
| `feedgen status` | 查看运行状态 |
| `feedgen logs backend -f` | 实时查看后端日志 |
| `feedgen logs frontend -f` | 实时查看前端日志 |
| `feedgen logs all` | 查看全部日志 |
| `feedgen start backend` | 仅启动后端 |
| `feedgen stop frontend` | 仅停止前端 |
| `feedgen restart backend` | 仅重启后端 |
| `feedgen enable` | 设置开机自启 |
| `feedgen disable` | 取消开机自启 |
| `feedgen install` | 安装 npm 依赖 |
| `feedgen build` | 编译后端 |
| `feedgen info` | 查看访问地址 |
| `feedgen setup` | 重新初始化配置与服务 |
| `feedgen help` | 帮助 |

## 访问地址

| 服务 | 地址 |
|------|------|
| 前端 | http://127.0.0.1:3001 |
| 后端 API | http://127.0.0.1:3000/api |
| 对外 API（nginx） | 见 `frontend/config.js` 中 `API_BASE_URL` |

## 日志位置

- 文件：`logs/backend.log`、`logs/backend.error.log`、`logs/frontend.log`、`logs/frontend.error.log`
- systemd：`journalctl -u feedgen-backend`、`journalctl -u feedgen-frontend`

## 故障排查

1. **页面空白 / 文章为空**：先 `feedgen status`，若后端 HTTP 非 200，执行 `feedgen restart backend`，再 `feedgen logs backend -n 50` 查看报错。
2. **前端启动失败（端口占用）**：`lsof -i:3001` 检查是否有残留 `http-server`，`feedgen stop frontend` 后 `feedgen start frontend`。
3. **后端 TypeScript 编译失败**：`cd backend && npx tsc --noEmit` 定位错误，修复后 `feedgen restart backend`。
4. **systemd 单元变更后**：`systemctl daemon-reload && feedgen restart`。

## 首次部署

```bash
feedgen setup      # 生成 scripts/feedgen.env 与 systemd 单元
feedgen install    # 安装依赖
feedgen start      # 启动服务
feedgen enable     # 可选：开机自启
```
