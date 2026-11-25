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

## 认证来源：哪种最稳

| 方式 | 稳定性 | 说明 |
|---|---|---|
| `connection.authenticatedUrl()` | ★★★★★ | Host 进程内直取本进程的 launchToken（只在内存、不落盘），不依赖日志、不受日志轮转影响 |
| 持久 cookie 缓存 | ★★★★☆ | cookie 由持久 secret 签名、有效期按 `cookieMaxAgeDays`（天数级）。换到一次后缓存到磁盘，重启直接复用，只有 401 才重建 |
| 日志 `token=` | ★★☆☆☆ | 只在打印启动 URL 时出现，依赖日志存在、未轮转、可读；仅作兜底 |
| 自己用 secret 签 cookie | ★★★☆☆ | secret 在 credentials 的 `client-connection/browser-session`，可读；但 cookie payload 属内部实现，升级易坏，不建议 |

本插件的取用顺序是 **进程内 token → 缓存 cookie → 日志 token**：

- 正常重启：直接用缓存 cookie，连 token 都不用换；
- 缓存超期或 secret 轮换：才走一次 token 换取；
- 只有在 Host 内部接口不可用时，日志才作为最后兜底。

所以「日志被清、日志轮转、权限不对」都不会再让网关失联。

## 认证：默认开放，按需加锁

默认 `auth.mode: none` —— 网关不做任何认证，直接放行（Host 自己的会话就是凭证）。

需要加锁时，三档现成模式 + 一个完全自定义入口：

### basic

```yaml
auth:
  mode: basic
  basic: { username: admin, password: change-me }
```

浏览器会弹原生登录框；密码用常量时间比较。

### header

```yaml
auth:
  mode: header
  header: { name: x-gateway-token, value: your-long-secret }
```

适合给脚本、上游反代、监控探针用。

### custom —— 自己写认证代码

```yaml
auth:
  mode: custom
  custom:
    module: /srv/me/my-auth.mjs
```

`my-auth.mjs` 只要导出 `authenticate(req)`，返回 `true/false`（也可以返回 Promise）：

```js
// /srv/me/my-auth.mjs
export function authenticate(req) {
  const key = req.headers['x-api-key']
  return key === process.env.MY_KEY
}
```

不想落文件也可以，插件实例上直接注册：

```js
gateway.use((req) => req.headers['x-inline'] === '1')
```

拒绝语义：认证不通过 `401`；模块抛错 `403`；模块没进到 `503`。
**WebSocket 升级请求走同一套认证**，不会从 upgrade 通道绕过去。

## 设置页

插件带浏览器半。装好后打开 **设置 → 免认证网关**，可以直接改：

- 启用 / 关闭网关
- 监听地址与端口（`0.0.0.0` = 局域网可达）
- 上游地址与端口
- 认证模式：`none` / `basic` / `header` / `custom`
- 会话缓存文件路径

保存会写进当前 profile 的 patch（走 DSH 的 `configEditor`）。**监听地址/端口改动需要重启 DSH**，其余字段保存即写入。

界面顶部还会显示实时状态：监听地址、上游、会话是否已建立、请求与 WebSocket 升级计数。

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
| `cookieCache` | `~/.dsh/auth-gateway-cookie` | 会话缓存文件（0600）；设为 `""` 可禁用 |
| `auth` | `{ mode: "none" }` | 认证模式：`none` / `basic` / `header` / `custom` |

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
