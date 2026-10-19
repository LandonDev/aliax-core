# aliax-core

The main-process core of [Aliax](https://github.com/LandonDev/aliax): the account vault, the Claude / Codex / Cursor adapters, usage polling, settings, and the gateway that forwards CLI traffic under a pinned account. Aliax and temp-code both depend on it as a git dependency pinned by commit.

Ships TypeScript source. No build step, no `electron` import. The host app calls `configure()` once at boot with its data directory, its fetch, its secret store and its hooks.

```ts
import { configure } from 'aliax-core'
configure({ dataDir, fetch: net.fetch, secrets: { mode: 'safeStorage', encrypt, decrypt }, appName: 'Aliax' })
```

`secrets` is one of `safeStorage` (Electron's, the Aliax app), `chromiumKey` (a second macOS app reading Aliax's vault through the same Keychain item), or `fileKey` (a random password in a 0600 file, for a Linux host with no Keychain; the blobs are the same bytes). CLI sign-ins come from the macOS Keychain or, off macOS, from the CLI's own file (`~/.claude/.credentials.json`); see `src/credentials.ts`.

`bun run typecheck && bun test` before every commit (wired as the pre-commit hook via `core.hooksPath`).
