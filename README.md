# dsh-auth-gateway

**免认证访问网关（DeepSeek Harness 插件）** — 在独立端口起一个 HTTP/WebSocket 反向代理，代理自己持有有效的 DSH 会话并注入每个转发请求，浏览器**不需要任何 token、cookie 或登录**。

> Zero-credential gateway for the DeepSeek Harness web GUI. The plugin owns a
> valid DSH session itself and injects it into every forwarded request, so a
> browser needs no token and no cookie.

---

## 它解决什么

DSH Web（默认 `127.0.0.1:3080`）用一次性 token 换 30 天 Cookie。直接暴露 3080 时，每个新设备都要先打开一次带 `?token=` 的地址；带 Cookie 策略、隐私模式、内嵌 iframe 或反向代理时还经常失败。

这个网关把「拿 Cookie」这件事从浏览器搬到 Host 进程里：

1. 通过 Host 的 `connection.authenticatedUrl()` 拿到当前带认证的 URL（回退：从服务日志里抓最新的 `token=`）；
2. 自己向 DSH 换一个 session Cookie；
3. 转发每个请求时用这个 Cookie 覆盖浏览器带来的 Cookie；
4. WebSocket 升级同样注入；
5. 上游返回 401 时自动丢掉旧 Cookie、下次重建。

浏览器端因此是**零凭证**的：打开网关端口就能用。

## 安全模型（先读这段）

- 这个插件**不放宽 DSH 的授权**：它复用的是 Host 本来就信任的本地会话。
- 但**任何能访问监听地址的人，就拿到了这个会话**——也就是完整 DSH 控制权（能执行命令、读写文件）。
- 所以默认 `host` 是 `127.0.0.1`。要局域网访问必须显式改成 `0.0.0.0`，请自行确认网络边界；**不要**把网关端口直接映射到公网，公网请走带认证的隧道（Cloudflare Access 等）。
- 日志里的 `token=` 只在插件拿不到内部认证 URL 时才会被读取；它等价于凭证，日志文件请保持私有权限。

## 安装

```bash
# 从 GitHub（推荐先看一遍源码）
dsh plugin --profile web add github:kssku/dsh-auth-gateway

# 或本地开发：把仓库链接进 profile 的 node_modules
ln -s /srv/repos/GitHub/dsh-auth-gateway /srv/dsh/profiles/web/node_modules/dsh-auth-gateway
```

然后在该 profile 的 `package.json` 里把 `dsh-auth-gateway` 加进 `dsh.profile.bundles`，重启 DSH。插件会由自带的 `cordis.patch.yml` 插入一行 `auth-gateway`。

**从旧的独立脚本迁移**：插件和 `dsh-auth-proxy.js` 会抢同一个端口。先停掉旧进程，再启用插件：

```bash
pkill -f dsh-auth-proxy.js          # 确认没有 systemd 单元会自动拉起
systemctl restart dsh-web-root
```

## 配置

配置走 profile 的 `cordis.patch.yml`：

```yaml
- id: auth-gateway
  config:
    enabled: true
    host: 127.0.0.1      # 局域网访问用 0.0.0.0（先读安全模型）
    port: 3084
    targetHost: 127.0.0.1
    targetPort: 3080
    tokenLog: /var/log/dsh-web.log
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则不监听 |
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `3084` | 监听端口 |
| `targetHost` | `127.0.0.1` | 上游 DSH 地址 |
| `targetPort` | `3080` | 上游 DSH 端口 |
| `tokenLog` | `/var/log/dsh-web.log` | 内部认证不可用时的 token 回退来源 |

改完重启 DSH 生效。

## 排查

| 现象 | 原因 / 处理 |
|---|---|
| 启动日志出现 `端口 3084 已被占用` | 旧代理进程还在，`pkill -f dsh-auth-proxy.js` 后重启 |
| 返回 502 `upstream error` | 上游 DSH 未启动或 `targetPort` 不对 |
| 页面能开但一直 401 | token 回退失效：检查 `tokenLog` 路径，或先直接访问一次 `http://127.0.0.1:3080/?token=...` 让日志里有新 token |
| WebSocket 连不上 | 网关只做 TCP 透传；确认上游端口和防火墙允许长连接 |

## 实现

- 纯 ESM、零依赖，无构建步骤；只用到 `node:http`、`node:net`、`node:fs`。
- 端口占用等错误只记录在插件状态里，不会让 Host 崩溃。
- `apply()` 返回 `{ status, start, stop }`，便于后续接设置页或状态工具。

## License

MIT
