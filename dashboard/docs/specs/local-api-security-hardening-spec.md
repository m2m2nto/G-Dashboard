# Spec: Local API Security Hardening

> **Status:** Shipped on `main`. Documents the security hardening landed after codebase review.

## Objective

Reduce exposure of the local Express API used by the Electron/Vite application. The app manages financial Excel files and attachment files, so localhost-only assumptions must be enforced by the server, not left to developer convention.

## Context

Before hardening:

- `server/index.js` used default `app.listen(PORT)`, which binds to all interfaces on many Node platforms.
- `app.use(cors())` allowed any origin to call local API endpoints.
- Settings native-dialog routes interpolated request-provided `title` / default path values into AppleScript without escaping.

This was acceptable for quick local development but unsafe for a desktop financial app because the API can mutate Excel files, browse configured directories, manage settings, and open/copy attachments.

## Shipped Behavior

### Loopback-only binding

`server/index.js` now listens on `127.0.0.1` by default via `getListenHost()` from `server/services/httpSecurity.js`.

```js
const HOST = getListenHost();
app.listen(PORT, HOST, async () => { ... });
```

`HOST` may still be overridden by environment variable for deliberate development scenarios, but the safe default is loopback only.

### Local-origin CORS

CORS is restricted with `localCorsOptions`:

- allowed with no `Origin` header (same-origin/server-side requests)
- allowed local origins:
  - `http://localhost:*`
  - `http://127.0.0.1:*`
  - `http://[::1]:*`
- rejected non-local origins such as LAN IPs or arbitrary websites

### Shared AppleScript escaping

`server/services/osascript.js` exports `escapeForOsascript(str)`, which:

- escapes backslashes
- escapes double quotes
- strips `\r` / `\n`

Both attachment routes and settings routes use this helper for native macOS dialog script strings.

## Files

- `server/index.js` — loopback host + restricted CORS wiring
- `server/services/httpSecurity.js` — local-origin and listen-host helpers
- `server/services/osascript.js` — shared AppleScript escaping helper
- `server/routes/attachments.js` — uses shared AppleScript escaping
- `server/routes/settings.js` — uses shared AppleScript escaping and exported script builders
- `server/tests/http-security.test.js` — CORS/host regression coverage
- `server/tests/settings-osascript.test.js` — settings AppleScript escaping coverage
- `server/tests/attachments-route.test.js` — attachment AppleScript escaping coverage

## Boundaries

Always:

- Keep the default API bind host loopback-only.
- Keep CORS restricted to local origins.
- Escape every interpolated AppleScript string before invoking `osascript`.
- Treat request bodies for native-dialog routes as untrusted input.
- Keep tests for host/CORS decisions and AppleScript escaping.

Ask first:

- Binding to `0.0.0.0` or a LAN IP.
- Reopening wildcard CORS.
- Adding unauthenticated endpoints that read/write arbitrary host paths.
- Adding new native-dialog routes or shell-command routes.

Never:

- Use `app.use(cors())` without an origin allow-list.
- Interpolate user-controlled strings into AppleScript without `escapeForOsascript`.
- Treat Electron/localhost context as sufficient authorization for filesystem mutation.

## Verification

Shipped verification:

- `npm audit --audit-level=high` → zero high/critical vulnerabilities after dependency upgrades.
- `npm test` → all server/client tests pass, including new security regressions.
- `npm run build --workspace=client` → succeeds.
- `bash scripts/build-electron.sh` → succeeds with Electron 42 / electron-builder 26.
- Playwright smoke test → app loads and core navigation works without console/API errors.

## Follow-ups

- Consider an Electron-generated per-session API token if the app ever exposes broader host access or needs defense-in-depth beyond loopback + local-origin CORS.
- Consider security headers for packaged-client serving mode if the app starts loading any remote content.
