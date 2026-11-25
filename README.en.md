# dsh-auth-gateway

**Zero-credential gateway for DeepSeek Harness.** A reverse proxy that owns a
valid DSH session inside the Host process and injects it into every forwarded
HTTP/WebSocket request — so a browser needs no token and no cookie.

## How it works

1. Resolve an authenticated URL through the Host `connection` service
   (`connection.authenticatedUrl()`); fall back to the launch token printed in
   the server log.
2. Mint a session cookie from it and keep it in memory.
3. Cache the cookie on disk (`~/.dsh/auth-gateway-cookie`, mode 0600) so a
   restart does not need to fetch a token again.
4. Overwrite the browser's cookie with the Host-owned one on every request and
   on WebSocket upgrades; drop it and rebuild on upstream `401`.

## Security

- The gateway does **not** widen DSH authorization; it reuses the session the
  Host already trusts.
- Anyone who can reach the listen address gets that session — full control of
  this DSH. Bind to `127.0.0.1` unless you really mean it.
- Never expose the gateway port to the public internet. Put an authenticated
  tunnel (Cloudflare Access, etc.) in front of it.
- `auth.mode` defaults to `none`. Use `basic`, `header`, or `custom` to gate it.

## Install

```bash
dsh plugin --profile web add github:kssku/dsh-auth-gateway
```

Add `@kssku/dsh-auth-gateway` to `dsh.profile.bundles` in the profile's
`package.json`, then restart DSH. The plugin inserts its own `auth-gateway`
row through `cordis.patch.yml`.

## Configuration

```yaml
- id: auth-gateway
  config:
    enabled: true
    host: 127.0.0.1
    port: 3084
    targetHost: 127.0.0.1
    targetPort: 3080
    tokenLog: /var/log/dsh-web.log
    cookieCache: ~/.dsh/auth-gateway-cookie
    auth:
      mode: none
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Stop listening when false |
| `host` | `127.0.0.1` | Bind address; `0.0.0.0` for LAN |
| `port` | `3084` | Listen port |
| `targetHost` / `targetPort` | `127.0.0.1` / `3080` | Upstream DSH |
| `tokenLog` | `/var/log/dsh-web.log` | Last-resort token source |
| `cookieCache` | `~/.dsh/auth-gateway-cookie` | Session cache (`""` disables) |
| `auth` | `{ mode: "none" }` | `none` / `basic` / `header` / `custom` |

### Auth modes

- `basic`: `basic: { username, password }`
- `header`: `header: { name, value }`
- `custom`: `custom: { module: /path/auth.mjs }` exporting
  `authenticate(req) => boolean | Promise<boolean>`; or call
  `gateway.use((req) => ...)` in-process.

## Settings page

The plugin ships a browser half: **Settings → Zero-credential gateway** edits
the listen address, upstream, auth mode and cache path, and shows live status
(listening, session, requests, upgrades). Saving goes through DSH's
`configEditor`; listen address/port changes need a DSH restart.

## Development

```bash
npm ci
npm run check      # typecheck + build + manifest validation
npm run pack:check # inspect the npm tarball
```

## License

MIT
