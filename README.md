# aliax-core

The main-process core of [Aliax](https://github.com/LandonDev/aliax): the account vault, the Claude / Codex / Cursor adapters, usage polling, settings, and the gateway that forwards CLI traffic under a pinned account. Aliax and temp-code both depend on it as a git dependency pinned by commit.

Ships TypeScript source. No build step, no `electron` import. The host app calls `configure()` once at boot with its data directory, its fetch, its secret store and its hooks.

```ts
import { configure } from 'aliax-core'
configure({ dataDir, fetch: net.fetch, secrets: { mode: 'safeStorage', encrypt, decrypt }, appName: 'Aliax' })
```

`secrets` is one of `safeStorage` (Electron's, the Aliax app), `chromiumKey` (a second macOS app reading Aliax's vault through the same Keychain item), or `fileKey` (a random password in a 0600 file, for a Linux host with no Keychain; the blobs are the same bytes). CLI sign-ins come from the macOS Keychain or, off macOS, from the CLI's own file (`~/.claude/.credentials.json`); see `src/credentials.ts`.

One account on several machines (`src/sync.ts`, `src/refresh.ts`): every profile has one owner, named by the host's `environmentId` (absent on a profile means this machine). The owner alone presents the refresh token; every other host holds an access-only copy that the owner pushes on each rotation (`exportAccount`, `applyTransfer`) and asks the owner for through the `askOwner` hook near its end. A static profile (a `claude setup-token` bearer, `saveStaticClaude`) has no refresh token and no owner, is inference-only, and lapses at its own expiry. No transfer goes backwards by the access token's expiry; `onSecretSaved` tells the host about every vault write and whether it was this machine's own. A handoff is two-phase and the grant has one refresher throughout: the sender exports under the profile's lock (`src/lock.ts`, the same lock `refresh.ts` holds, so a refresh never interleaves with a change of owner, and the save after a token endpoint answers re-reads ownership and never writes a refresh token into a copy owned elsewhere), the receiver saves the grant provisionally (the row still names the sender, so nothing refreshes it there) and answers with the fingerprint of the refresh token it saved (`refreshFingerprint`, a digest, never the token), the sender strips its own copy only on an answer that echoes what it sent (`beginHandoff` → `commit`, else `abort`), and the receiver makes itself the owner on the sender's word (`claimHandoff`). An older handoff onto a host with no refresh token is refused as `stale`. Under the `peer` policy `applyTransfer` lands only accounts already on file and only access copies the sender owns, so a host accepts account state only for accounts it paired or owns.

`bun run typecheck && bun test` before every commit (wired as the pre-commit hook via `core.hooksPath`).
