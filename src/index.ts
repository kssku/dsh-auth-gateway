/**
 * dsh-auth-gateway — host half.
 *
 * A zero-credential gateway for the DSH web GUI. It listens on its own port
 * and reverse-proxies the DSH HTTP + WebSocket surface. The plugin owns a
 * valid DSH session itself (obtained through the Host `connection` service,
 * falling back to the launch token in the server log) and injects it into
 * every forwarded request, so the browser needs no token and no cookie.
 *
 * Design notes:
 *  - No external dependencies, no build step; plain ESM on node:http/net/fs.
 *  - Failures are recorded in `status()`; a port clash never crashes the Host.
 *  - The gateway never widens DSH authorization: it reuses the local session
 *    the Host already trusts. Anyone who can reach the listen address gets
 *    that session, so bind to loopback unless you really mean it.
 */

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** Stable cordis plugin name. */
export const name = 'auth-gateway'

/** Services required before the gateway can resolve a session. */
export const inject = ['connection', 'webServer']

const CONFIG_ROUTE = '/api/dsh-auth-gateway/config'

const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  port: 3084,
  targetHost: '127.0.0.1',
  targetPort: 3080,
  tokenLog: '/var/log/dsh-web.log',
  cookieCache: path.join(os.homedir(), '.dsh', 'auth-gateway-cookie'),
  auth: { mode: 'none' },
}

/**
 * Mount the gateway.
 * @param ctx - host plugin context carrying the `connection` service.
 * @param config - plugin config; values may be plain or volatile refs.
 */
export function apply(ctx, config = {}) {
  const read = (key) => {
    const raw = config[key]
    if (raw && typeof raw.get === 'function') {
      try {
        const live = raw.get()
        if (live !== undefined && live !== null) return live
      } catch { /* fall through to the default */ }
    }
    return raw === undefined || raw === null ? DEFAULTS[key] : raw
  }

  const state = {
    requests: 0,
    upgrades: 0,
    sessionBuilds: 0,
    lastError: null,
    listening: null,
    startedAt: Date.now(),
  }

  let server = null
  let sessionCookie = null
  let sessionBusy = false

  /** Persistent cookie cache: a minted cookie stays valid because the signing
   *  secret is durable, so a restart can reuse it instead of asking for a token. */
  function cachePath() {
    const raw = read('cookieCache')
    return raw === false || raw === '' || raw === null ? null : String(raw)
  }
  function loadCachedCookie() {
    const file = cachePath()
    if (!file) return null
    try {
      const value = fs.readFileSync(file, 'utf8').trim()
      return value || null
    } catch {
      return null
    }
  }
  function saveCachedCookie(cookie) {
    const file = cachePath()
    if (!file || !cookie) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, cookie, { mode: 0o600 })
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, file)
    } catch (error) {
      note(error)
    }
  }
  function clearCachedCookie() {
    const file = cachePath()
    if (!file) return
    try { fs.unlinkSync(file) } catch { /* already gone */ }
  }
  const sessionQueue = []

  const targetHost = () => String(read('targetHost'))
  const targetPort = () => Number(read('targetPort'))
  const hostHeader = () => `${targetHost()}:${targetPort()}`
  const targetOrigin = () => `http://${targetHost()}:${targetPort()}`

  function note(error) {
    state.lastError = String((error && error.message) || error)
    console.error('[auth-gateway]', state.lastError)
  }

  /** Ask the Host for an authenticated URL and pull the launch token out of it. */
  function internalToken() {
    try {
      const connection = ctx.connection
      if (connection && typeof connection.authenticatedUrl === 'function') {
        const url = connection.authenticatedUrl(targetOrigin())
        const match = /[?&]token=([A-Za-z0-9_.-]+)/.exec(String(url || ''))
        if (match) return match[1]
      }
    } catch (error) {
      note(error)
    }
    return null
  }

  /** Fallback: the newest `token=` printed by the DSH web server. */
  function logToken() {
    try {
      const text = fs.readFileSync(String(read('tokenLog')), 'utf8')
      const matches = text.match(/token=([A-Za-z0-9_-]+)/g)
      if (!matches || !matches.length) return null
      return matches[matches.length - 1].slice(6)
    } catch {
      return null
    }
  }

  function verifyToken(token, done) {
    if (!token) return done(null)
    const request = http.request(
      {
        host: targetHost(),
        port: targetPort(),
        path: '/?token=' + encodeURIComponent(token),
        method: 'GET',
        headers: { Host: hostHeader() },
      },
      (response) => {
        response.resume()
        const ok = response.statusCode === 200 || response.statusCode === 303
        done(ok ? token : null)
      },
    )
    request.on('error', () => done(null))
    request.setTimeout(4000, () => {
      request.destroy()
      done(null)
    })
    request.end()
  }

  /** Build (or rebuild) the Host-owned session cookie. */
  function buildSession(done) {
    sessionQueue.push(done)
    if (sessionBusy) return
    sessionBusy = true
    const finish = (cookie) => {
      sessionCookie = cookie
      if (cookie) saveCachedCookie(cookie)
      else clearCachedCookie()
      sessionBusy = false
      state.sessionBuilds += 1
      const queued = sessionQueue.splice(0)
      for (const callback of queued) {
        try { callback(cookie) } catch { /* consumer went away */ }
      }
    }
    const token = internalToken() || logToken()
    verifyToken(token, (ok) => {
      if (!ok) return finish(null)
      const request = http.request(
        {
          host: targetHost(),
          port: targetPort(),
          path: '/?token=' + encodeURIComponent(ok),
          method: 'GET',
          headers: { Host: hostHeader() },
        },
        (upstream) => {
          const cookies = upstream.headers['set-cookie']
          upstream.resume()
          finish(cookies && cookies.length ? cookies.map((c) => c.split(';')[0]).join('; ') : null)
        },
      )
      request.on('error', () => finish(null))
      request.setTimeout(6000, () => {
        request.destroy()
        finish(null)
      })
      request.end()
    })
  }

  function ensureSession(done) {
    if (sessionCookie) return done(sessionCookie)
    buildSession(done)
  }

  /* ── authentication extension point ─────────────────────────────────
   * Default mode `none` keeps the gateway open (the Host session is the
   * credential). Operators who need a gate pick `basic` / `header`, or point
   * `auth.custom.module` at their own module exporting
   * `authenticate(req) -> boolean | Promise<boolean>`.
   */
  let customAuth = null
  let customAuthError = null

  function safeEqual(a, b) {
    const left = Buffer.from(String(a == null ? '' : a))
    const right = Buffer.from(String(b == null ? '' : b))
    if (left.length !== right.length) return false
    return crypto.timingSafeEqual(left, right)
  }

  function deny(status: number, headers: Record<string, string> = {}, body = 'unauthorized') {
    return { status, headers: headers || {}, body: body || 'unauthorized' }
  }

  function authConfig() {
    const value = read('auth')
    return value && typeof value === 'object' ? value : { mode: 'none' }
  }

  function loadCustomAuth() {
    const auth = authConfig()
    if (String(auth.mode || '').toLowerCase() !== 'custom') return
    const spec = auth.custom && auth.custom.module
    if (!spec) {
      customAuthError = 'auth.mode=custom 但未配置 auth.custom.module'
      note(customAuthError)
      return
    }
    const target = String(spec)
    const href = target.startsWith('file:') ? target : pathToFileURL(path.resolve(target)).href
    import(href)
      .then((mod) => {
        const fn = (mod && (mod.authenticate || mod.default)) || null
        if (typeof fn !== 'function') throw new Error('自定义认证模块必须导出 authenticate(req) 或 default')
        customAuth = fn
        console.log('[auth-gateway] custom authenticator loaded: ' + target)
      })
      .catch((error) => {
        customAuthError = String((error && error.message) || error)
        note(error)
      })
  }

  function authorize(request, done) {
    const auth = authConfig()
    const mode = String(auth.mode || 'none').toLowerCase()
    if (mode === 'none') return done(null)
    if (mode === 'basic') {
      const cfg = auth.basic || {}
      const challenge = { 'WWW-Authenticate': 'Basic realm="dsh-auth-gateway"' }
      const header = String(request.headers.authorization || '')
      const match = /^Basic\s+(.+)$/i.exec(header)
      if (!match) return done(deny(401, challenge))
      const decoded = Buffer.from(match[1], 'base64').toString('utf8')
      const split = decoded.indexOf(':')
      const user = split < 0 ? decoded : decoded.slice(0, split)
      const pass = split < 0 ? '' : decoded.slice(split + 1)
      if (safeEqual(user, cfg.username) && safeEqual(pass, cfg.password)) return done(null)
      return done(deny(401, challenge))
    }
    if (mode === 'header') {
      const cfg = auth.header || {}
      const name = String(cfg.name || '').toLowerCase()
      const got = name ? String(request.headers[name] || '') : ''
      if (cfg.value && safeEqual(got, cfg.value)) return done(null)
      return done(deny(401, {}, 'missing or invalid gateway header'))
    }
    if (mode === 'custom') {
      if (!customAuth) return done(deny(503, {}, customAuthError || 'custom authenticator not loaded'))
      try {
        const result = customAuth(request)
        if (result && typeof result.then === 'function') {
          result.then((ok) => done(ok ? null : deny(401))).catch((error) => { note(error); done(deny(403)) })
        } else {
          done(result ? null : deny(401))
        }
      } catch (error) {
        note(error)
        done(deny(403))
      }
      return
    }
    return done(deny(403, {}, 'unknown auth mode: ' + mode))
  }

  function refuse(response, denied) {
    if (response.headersSent) return response.end()
    response.writeHead(denied.status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, denied.headers))
    response.end(denied.body)
  }

  /* ── settings API ────────────────────────────────────────────────────
   * The browser half (lib/client.js) reads and writes this one endpoint.
   * Saving goes through configEditor, which persists the value to the
   * profile patch; host/port changes need a DSH restart to rebind.
   */
  function statusOf() {
    return {
      listening: state.listening,
      target: hostHeader(),
      session: Boolean(sessionCookie),
      requests: state.requests,
      upgrades: state.upgrades,
      sessionBuilds: state.sessionBuilds,
      lastError: state.lastError,
    }
  }

  function publicConfig() {
    const auth = authConfig()
    return {
      enabled: Boolean(read('enabled')),
      host: String(read('host') || ''),
      port: Number(read('port') || 0),
      targetHost: String(read('targetHost') || ''),
      targetPort: Number(read('targetPort') || 0),
      cookieCache: String(read('cookieCache') || ''),
      tokenLog: String(read('tokenLog') || ''),
      auth: {
        mode: String(auth.mode || 'none'),
        basic: {
          username: String((auth.basic && auth.basic.username) || ''),
          hasPassword: Boolean(auth.basic && auth.basic.password),
        },
        header: {
          name: String((auth.header && auth.header.name) || ''),
          hasValue: Boolean(auth.header && auth.header.value),
        },
        custom: { module: String((auth.custom && auth.custom.module) || '') },
      },
    }
  }

  function mergeConfig(previous, incoming) {
    const next = Object.assign({}, previous)
    for (const key of ['enabled', 'host', 'port', 'targetHost', 'targetPort', 'cookieCache', 'tokenLog']) {
      if (incoming[key] !== undefined && incoming[key] !== null) next[key] = incoming[key]
    }
    const auth = Object.assign({}, previous.auth)
    const from = incoming.auth || {}
    if (from.mode) auth.mode = from.mode
    if (from.basic) {
      auth.basic = Object.assign({}, auth.basic)
      if (from.basic.username !== undefined) auth.basic.username = from.basic.username
      if (from.basic.password) auth.basic.password = from.basic.password
    }
    if (from.header) {
      auth.header = Object.assign({}, auth.header)
      if (from.header.name !== undefined) auth.header.name = from.header.name
      if (from.header.value) auth.header.value = from.header.value
    }
    if (from.custom) {
      auth.custom = Object.assign({}, auth.custom)
      if (from.custom.module !== undefined) auth.custom.module = from.custom.module
    }
    next.auth = auth
    return next
  }

  async function saveConfig(incoming) {
    const editor = ctx.configEditor
    if (!editor || typeof editor.edit !== 'function') {
      throw new Error('configEditor 服务不可用；请直接改 profile 的 cordis.patch.yml')
    }
    const entry = editor.entries().find((candidate) => candidate && candidate.options && candidate.options.id === 'auth-gateway')
    if (!entry) throw new Error('找不到 auth-gateway 配置条目（可能尚未由 patch 插入）')
    await editor.edit(entry, (current) => mergeConfig(current || {}, incoming || {}))
    return publicConfig()
  }

  function sameOrigin(request) {
    const origin = request.headers.origin
    if (!origin) return true
    try {
      return new URL(origin).host === request.headers.host
    } catch {
      return false
    }
  }

  function readJson(request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) {
          reject(new Error('body too large'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch (error) {
          reject(error)
        }
      })
      request.on('error', reject)
    })
  }

  function sendJson(response, status, payload) {
    if (response.headersSent) return
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(payload))
  }

  async function handleConfigRequest(request, response) {
    if (!sameOrigin(request)) return sendJson(response, 403, { ok: false, message: 'cross-origin request rejected' })
    try {
      if (request.method === 'GET') {
        return sendJson(response, 200, { ok: true, config: publicConfig(), status: statusOf() })
      }
      if (request.method !== 'POST') return sendJson(response, 405, { ok: false, message: 'GET or POST only' })
      const body = await readJson(request)
      if (!body || body.op !== 'save') return sendJson(response, 400, { ok: false, message: 'op must be save' })
      const config = await saveConfig(body.config)
      return sendJson(response, 200, { ok: true, config, status: statusOf(), restartRequired: true })
    } catch (error) {
      note(error)
      return sendJson(response, 500, { ok: false, message: String((error && error.message) || error) })
    }
  }

  /** Browsers reject Secure/SameSite/Partitioned cookies on plain http origins. */
  function loosenCookie(cookie) {
    return cookie
      .replace(/;\s*SameSite=[^;]*/gi, '')
      .replace(/;\s*Secure/gi, '')
      .replace(/;\s*Partitioned/gi, '')
  }

  function proxy(request, response) {
    state.requests += 1
    authorize(request, (denied) => {
      if (denied) return refuse(response, denied)
      state.requests += 1
      ensureSession((cookie) => {
        const headers = Object.assign({}, request.headers)
        headers.host = hostHeader()
        if (cookie) headers.cookie = cookie
        else delete headers.cookie

        if (headers.origin) headers.origin = targetOrigin()
        if (headers.referer) {
          try {
            const parsed = new URL(headers.referer)
            headers.referer = targetOrigin() + parsed.pathname + parsed.search
          } catch {
            headers.referer = targetOrigin() + '/'
          }
        }

        const upstreamRequest = http.request(
          { host: targetHost(), port: targetPort(), method: request.method, path: request.url, headers },
          (upstream) => {
            if (upstream.statusCode === 401 && cookie) { sessionCookie = null; clearCachedCookie() }
            const outgoing = Object.assign({}, upstream.headers)
            if (outgoing['set-cookie']) outgoing['set-cookie'] = outgoing['set-cookie'].map(loosenCookie)
            response.writeHead(upstream.statusCode || 502, outgoing)
            upstream.pipe(response)
          },
        )
        upstreamRequest.on('error', (error) => {
          note(error)
          if (!response.headersSent) {
            response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
          }
          response.end('dsh-auth-gateway: upstream error: ' + ((error && error.message) || error))
        })
        request.pipe(upstreamRequest)
      })
    })
  }

  /** WebSocket: TCP passthrough with the Host session cookie injected. */
  function onUpgrade(request, socket, head) {
    state.upgrades += 1
    authorize(request, (denied) => {
      if (denied) {
        const label = denied.status === 401 ? 'Unauthorized' : 'Denied'
        socket.end(`HTTP/1.1 ${denied.status} ${label}\r\nConnection: close\r\n\r\n`)
        return
      }
      state.upgrades += 1
      ensureSession((cookie) => {
        const upstream = net.connect(targetPort(), targetHost(), () => {
          let raw = `${request.method} ${request.url} HTTP/1.1\r\n`
          for (const [key, value] of Object.entries(request.headers)) {
            const lower = key.toLowerCase()
            if (lower === 'host' || lower === 'origin' || lower === 'cookie') continue
            raw += `${key}: ${value}\r\n`
          }
          raw += `Host: ${hostHeader()}\r\n`
          raw += `Origin: ${targetOrigin()}\r\n`
          if (cookie) raw += `Cookie: ${cookie}\r\n`
          raw += '\r\n'
          upstream.write(raw)
          if (head && head.length) upstream.write(head)
          upstream.pipe(socket)
          socket.pipe(upstream)
        })
        upstream.on('error', () => socket.destroy())
        socket.on('error', () => upstream.destroy())
      })
    })
  }

  function start() {
    if (server || !read('enabled')) return
    if (!sessionCookie) sessionCookie = loadCachedCookie()
    server = http.createServer(proxy)
    server.on('upgrade', onUpgrade)
    server.on('error', (error) => {
      state.lastError = error && error.code === 'EADDRINUSE'
        ? `端口 ${read('port')} 已被占用（先停掉旧的代理进程）`
        : String((error && error.message) || error)
      console.error('[auth-gateway]', state.lastError)
      try { server.close() } catch { /* already closed */ }
      server = null
      state.listening = null
    })
    server.listen(Number(read('port')), String(read('host')), () => {
      state.listening = `${read('host')}:${read('port')}`
      console.log(`[auth-gateway] ${state.listening} -> ${hostHeader()} (session injection)`)
    })
  }

  function stop() {
    if (!server) return
    try { server.close() } catch { /* ignore */ }
    server = null
    state.listening = null
    sessionCookie = null
  }

  loadCustomAuth()
  ctx.effect(() => {
    const web = ctx.webServer
    if (!web || typeof web.register !== 'function') return () => {}
    return web.register({ kind: 'exact', path: CONFIG_ROUTE, handler: handleConfigRequest })
  }, 'auth-gateway.route()')
  start()
  ctx.on('dispose', stop)

  return {
    status: () => ({
      enabled: Boolean(read('enabled')),
      listening: state.listening,
      target: hostHeader(),
      session: Boolean(sessionCookie),
      cookieCached: Boolean(sessionCookie && cachePath()),
      authMode: String(authConfig().mode || 'none'),
      customAuth: customAuth ? 'loaded' : (customAuthError || 'not-configured'),
      requests: state.requests,
      upgrades: state.upgrades,
      sessionBuilds: state.sessionBuilds,
      lastError: state.lastError,
      uptimeMs: Date.now() - state.startedAt,
    }),
    start,
    stop,
    /** Register an in-process authenticator instead of configuring a module. */
    use(fn) {
      if (typeof fn !== 'function') throw new TypeError('auth-gateway.use expects a function')
      const auth = authConfig()
      if (auth) auth.mode = 'custom'
      customAuth = fn
      customAuthError = null
      return () => { customAuth = null }
    },
  }
}
