# aliax-core

The main-process core of [Aliax](https://github.com/LandonDev/aliax): the account vault, the Claude / Codex / Cursor adapters, usage polling, settings, and the gateway that forwards CLI traffic under a pinned account. Aliax and temp-code both depend on it as a git dependency pinned by commit.

Ships TypeScript source. No build step, no `electron` import. The host app calls `configure()` once at boot with its data directory, its fetch, its secret store and its hooks.

```ts
import { configure } from 'aliax-core'
configure({ dataDir, fetch: net.fetch, secrets: { mode: 'safeStorage', encrypt, decrypt }, appName: 'Aliax' })
```

`secrets` is one of `safeStorage` (Electron's, the Aliax app), `chromiumKey` (a second macOS app reading Aliax's vault through the same Keychain item), or `fileKey` (a random password in a 0600 file, for a Linux host with no Keychain; the blobs are the same bytes). CLI sign-ins come from the macOS Keychain or, off macOS, from the CLI's own file (`~/.claude/.credentials.json`); see `src/credentials.ts`.

One account on several machines (`src/sync.ts`, `src/refresh.ts`): every profile has one owner, named by the host's `environmentId` (absent on a profile means this machine). The owner alone presents the refresh token; every other host holds an access-only copy that the owner pushes on each rotation (`exportAccount`, `applyTransfer`) and asks the owner for through the `askOwner` hook near its end. A static profile (a `claude setup-token` bearer, `saveStaticClaude`) has no refresh token and no owner, is inference-only, and lapses at its own expiry. No transfer goes backwards by the access token's expiry; `onSecretSaved` tells the host about every vault write and whether it was this machine's own.

`bun run typecheck && bun test` before every commit (wired as the pre-commit hook via `core.hooksPath`).
