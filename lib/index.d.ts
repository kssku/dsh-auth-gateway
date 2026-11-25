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
/** Stable cordis plugin name. */
export declare const name = "auth-gateway";
/** Services required before the gateway can resolve a session. */
export declare const inject: string[];
/**
 * Mount the gateway.
 * @param ctx - host plugin context carrying the `connection` service.
 * @param config - plugin config; values may be plain or volatile refs.
 */
export declare function apply(ctx: any, config?: {}): {
    status: () => {
        enabled: boolean;
        listening: any;
        target: string;
        session: boolean;
        cookieCached: boolean;
        authMode: string;
        customAuth: any;
        requests: number;
        upgrades: number;
        sessionBuilds: number;
        lastError: any;
        uptimeMs: number;
    };
    start: () => void;
    stop: () => void;
    /** Register an in-process authenticator instead of configuring a module. */
    use(fn: any): () => void;
};
