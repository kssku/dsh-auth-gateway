# Changelog

## 1.0.0

首个正式版本。

- Host 进程内 HTTP/WebSocket 反向代理，自动持有并注入 DSH 会话
- 认证来源优先级：`connection.authenticatedUrl()` → 持久 cookie 缓存 → 日志 token
- 会话缓存（默认 `~/.dsh/auth-gateway-cookie`，0600），重启不必重新取 token
- 可插拔认证：`none` / `basic` / `header` / `custom`（外部模块或 `gateway.use()`）
- 浏览器设置页（Settings → 免认证网关）：监听、上游、认证、缓存可视化编辑
- 端口占用等错误只记录在插件状态里，不影响 Host 进程

## 0.4.0

- 新增浏览器设置页与 `GET/POST /api/dsh-auth-gateway/config`

## 0.3.0

- 新增可插拔认证扩展点

## 0.2.0

- 新增持久会话缓存

## 0.1.0

- 初始版本：免认证网关
