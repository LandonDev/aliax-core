# aliax-core

The main-process core of [Aliax](https://github.com/LandonDev/aliax): the account vault, the Claude / Codex / Cursor adapters, usage polling, settings, and the gateway that forwards CLI traffic under a pinned account. Aliax and temp-code both depend on it as a git dependency pinned by commit.

Ships TypeScript source. No build step, no `electron` import. The host app calls `configure()` once at boot with its data directory, its fetch, its secret store and its hooks.

```ts
import { configure } from 'aliax-core'
configure({ dataDir, fetch: net.fetch, secrets: { mode: 'safeStorage', encrypt, decrypt }, appName: 'Aliax' })
```

`bun run typecheck && bun test` before every commit (wired as the pre-commit hook via `core.hooksPath`).
