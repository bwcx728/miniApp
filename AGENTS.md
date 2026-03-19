# AGENTS.md

## Cursor Cloud specific instructions

### Product overview

美甲预约微信小程序 (nail salon appointment booking WeChat Mini Program). Two apps live under `apps/`:

| App | Path | Tech |
|-----|------|------|
| Backend API | `apps/server/` | Node.js (zero deps), `node:http` + `node:sqlite` |
| WeChat Mini Program | `apps/weapp/` | Native WXML/WXSS/JS |

### Running the backend

```bash
npm run dev:server          # starts on http://127.0.0.1:3000
npm run test:server         # built-in self-test (uses temp SQLite DBs)
```

- Requires **Node.js >= 22** (`node:sqlite` is a built-in experimental module).
- **Zero npm dependencies** — no `npm install` needed. The server uses only Node.js built-in modules.
- SQLite DB is auto-created at `apps/server/data/miniapp.sqlite` on first start. Seed data (gallery items, booking rules) is auto-inserted.
- The `(node:…) ExperimentalWarning: SQLite is an experimental feature` warning is expected and harmless.

### Environment variables

See `docs/ENV.md` for full details. Key variables:

- `PORT` (default `3000`)
- `SQLITE_PATH` (default `apps/server/data/miniapp.sqlite`)
- `STAFF_OPEN_IDS` (default `staff-openid-v1`) — comma-separated staff OpenID whitelist

### Lint / check commands

```bash
npm run check:docs            # validates docs structure
npm run check:weapp-contract  # validates weapp contract self-check
```

There is no ESLint/Prettier configured in this repo.

### Testing the API manually

Use `X-Customer-OpenId` and `X-Staff-OpenId` headers for authentication (no real WeChat login needed locally). Default staff OpenID is `staff-openid-v1`. See `docs/API.md` for all endpoint contracts.

### WeChat frontend

The `apps/weapp/` directory is a native WeChat Mini Program. It cannot be tested in a headless Linux environment — it requires **WeChat Developer Tools** (macOS/Windows GUI app). The backend can be fully tested independently via curl or the built-in self-test.
