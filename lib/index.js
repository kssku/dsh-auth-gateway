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

/** Stable cordis plugin name. */
export const name = 'auth-gateway'

/** Services required before the gateway can resolve a session. */
export const inject = ['connection']

const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  port: 3084,
  targetHost: '127.0.0.1',
  targetPort: 3080,
  tokenLog: '/var/log/dsh-web.log',
  cookieCache: path.join(os.homedir(), '.dsh', 'auth-gateway-cookie'),
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

  /** Browsers reject Secure/SameSite/Partitioned cookies on plain http origins. */
  function loosenCookie(cookie) {
    return cookie
      .replace(/;\s*SameSite=[^;]*/gi, '')
      .replace(/;\s*Secure/gi, '')
      .replace(/;\s*Partitioned/gi, '')
  }

  function proxy(request, response) {
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
  }

  /** WebSocket: TCP passthrough with the Host session cookie injected. */
  function onUpgrade(request, socket, head) {
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

  start()
  ctx.on('dispose', stop)

  return {
    status: () => ({
      enabled: Boolean(read('enabled')),
      listening: state.listening,
      target: hostHeader(),
      session: Boolean(sessionCookie),
      cookieCached: Boolean(sessionCookie && cachePath()),
      requests: state.requests,
      upgrades: state.upgrades,
      sessionBuilds: state.sessionBuilds,
      lastError: state.lastError,
      uptimeMs: Date.now() - state.startedAt,
    }),
    start,
    stop,
  }
}
