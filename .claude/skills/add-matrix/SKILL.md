---
name: add-matrix
description: Add Matrix channel integration via Chat SDK. Works with any Matrix homeserver.
---

# Add Matrix Channel

Adds Matrix support via the Chat SDK bridge. NanoClaw doesn't ship channels in
trunk — this skill copies the Matrix adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter

Fetch the `channels` branch and copy the Matrix adapter into `src/channels/`
(overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/matrix.ts
src/channels/matrix-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './matrix.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`.
The Matrix adapter lives in the `@beeper/` namespace and versions on its own
track (not the `@chat-adapter/*` family), so it carries its own pin:

```nc:dep
@beeper/chat-adapter-matrix@0.2.0
```

### 4. Patch matrix-js-sdk ESM imports

The adapter's published dist references `matrix-js-sdk/lib/...` without `.js`
extensions, which fails under Node 22 strict ESM resolution. Add the missing
extensions (idempotent — safe to re-run). Re-run this after every `pnpm install`
that touches the adapter:

```nc:run effect:external
node -e '
  const fs = require("fs"), path = require("path");
  const root = "node_modules/.pnpm";
  const dir = fs.readdirSync(root).find(d => d.startsWith("@beeper+chat-adapter-matrix@"));
  if (!dir) { console.log("Matrix adapter not installed"); process.exit(0); }
  const f = path.join(root, dir, "node_modules/@beeper/chat-adapter-matrix/dist/index.js");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(
    /from "(matrix-js-sdk\/lib\/[^"]+?)(?<!\.js)"/g, "from \"$1.js\""
  ));
  console.log("Patched", f);
'
```

### 5. Build

Build guards the typed `createChatSdkBridge(...)` core call the adapter makes
and proves the dependency is installed and the ESM patch took. It also fails if
the `import './matrix.js';` line is missing or the barrel can't evaluate.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/matrix-registration.test.ts
```

`matrix-registration.test.ts` imports the real channel barrel and asserts the
registry contains `matrix`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@beeper/chat-adapter-matrix` isn't
installed (the import throws) — so it also covers the dependency from step 3.

End-to-end message delivery against a real Matrix homeserver is verified
manually once the service is running — see Next Steps.

## Credentials

The bot needs its own Matrix account — separate from the user's account. This is
required because Matrix cannot send DMs to yourself. These steps are human and
interactive (no parser can click through Element), so they stay prose.

### Create a bot account

1. Open [app.element.io](https://app.element.io) in a private/incognito window (or sign out first)
2. Register a new account for the bot (e.g. `andybot` on matrix.org)
3. Note the bot's user ID (e.g. `@andybot:matrix.org`)

### Choose an auth method

**Option A: Username + Password (simpler)**

No extra steps — just use the bot account's credentials directly. The adapter logs in automatically.

```bash
MATRIX_BASE_URL=https://matrix.org
MATRIX_USERNAME=andybot
MATRIX_PASSWORD=your-bot-password
MATRIX_USER_ID=@andybot:matrix.org
MATRIX_BOT_USERNAME=Andy
```

**Option B: Access Token (recommended for production)**

Get an access token from Element: sign into the bot account → **Settings** > **Help & About** > **Access Token** (under Advanced). Or via API:

```bash
curl -XPOST 'https://matrix.org/_matrix/client/r0/login' \
  -d '{"type":"m.login.password","user":"andybot","password":"..."}'
```

```bash
MATRIX_BASE_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=your-access-token
MATRIX_USER_ID=@andybot:matrix.org
MATRIX_BOT_USERNAME=Andy
```

### Optional settings

```bash
MATRIX_INVITE_AUTOJOIN=true                    # Auto-accept room invites (default: true)
MATRIX_INVITE_AUTOJOIN_ALLOWLIST=@you:matrix.org  # Only accept invites from these users
MATRIX_RECOVERY_KEY=your-recovery-key          # Enable E2EE cross-signing
MATRIX_DEVICE_ID=NANOCLAW01                    # Stable device ID across restarts
```

**E2EE gotchas** (`src/channels/matrix.ts` works around the first and third; the second is inherent to Matrix):

- Node/Bun have no `indexedDB` global, but `@beeper/chat-adapter-matrix`'s env-driven config never sets `e2ee.useIndexedDB`, so `initRustCrypto()` defaults to an IndexedDB-backed store and throws `"The indexedDB getter returned null or undefined"` on every boot. `matrix.ts` patches `useIndexedDB: false` onto the adapter after construction (`forceInMemoryE2EEStore`) — the crypto store is memory-only as a result, so device keys reset on every process restart (the recovery key re-establishes key-backup access on the next boot, but the device itself re-derives its identity).
- **Never reuse a `MATRIX_DEVICE_ID` that has ever had ANY key upload attempt — including a failed or empty one.** Matrix device identity keys are immutable once set; if a device_id already has a `device_keys` record on the homeserver (even a vacuous `keys: {}` one left over from a crashed attempt), every subsequent genuine signed key upload for that same device_id gets rejected with `400 M_BAD_JSON: Provided device_id in device_keys does not match that of the authenticated user device` — forever. If E2EE setup fails partway through, pick a brand new `MATRIX_DEVICE_ID` (e.g. increment a suffix) on retry rather than reusing the same value; check `/keys/query` for that device_id if unsure. Changing the device ID also requires clearing the adapter's persisted session (`chat_sdk_kv` rows keyed `matrix:session:*` / `matrix:device:*` for that instance in the central DB) so the next boot does a genuinely fresh login rather than reusing a token bound to the old device.
- Combining the first two points: **the memory-only store means every process restart burns the current `MATRIX_DEVICE_ID`.** A restart wipes the in-memory identity, but the OlmMachine re-uses the same configured device ID and generates a *different* random keypair — hitting the immutable-keys rejection above on its very first `/keys/upload`. There is no known safe fix for this today (a real Node-side IndexedDB shim was evaluated and rejected — `indexeddbshim` pulls in `canvas` as a side dependency, `npm audit` flags a critical CVE in its toolchain, and it fails a basic Node smoke test; `matrix-js-sdk` has had an open, unresolved request for Node-native crypto persistence since 2022). **Recovery procedure before restarting any host with a Matrix instance that has E2EE enabled:** run `pnpm exec tsx scripts/matrix-e2ee-rotate-device.ts [--instance matrix]` (add `--restart` to also restart the service). It bumps `MATRIX_DEVICE_ID` to a fresh value, clears that instance's persisted session and orphaned per-device sync-store cache in the central DB, and prints the exact restart command. No rebuild needed — it's a plain `.env` edit, not a code change. Verification then reapplies automatically on the next boot via `wrapWithSelfCrossSigning` — no manual action required.
- The adapter never self-verifies its own device, so other Matrix clients show it as "not verified" even with genuine E2EE working. `matrix.ts`'s `wrapWithSelfCrossSigning` calls `crypto.bootstrapCrossSigning({ setupNewCrossSigning: false })` after `initialize()` — the same operation as Element's "Verify with Security Key" — with a retry/backoff loop since the device's own `/keys/upload` (driven by the sync-triggered outgoing-request loop) doesn't necessarily complete before `initialize()` returns. `setupNewCrossSigning` must never be `true`: that resets the account's cross-signing keys and un-verifies every other device on the account.

### Store the credentials

Capture the values for the auth method you chose, then write them. `prompt` only
*asks* and binds the answer to a name; a separate directive consumes it — so the
same prompts could feed `ncl` or the OneCLI vault instead of `.env` by swapping
only the consumer. The homeserver URL, the bot's user ID, and a display name are
shared across both auth methods:

```nc:prompt base_url
Paste the homeserver base URL, e.g. `https://matrix.org`.
```
```nc:prompt user_id
Paste the bot's full Matrix user ID, e.g. `@andybot:matrix.org`.
```
```nc:prompt bot_username
Paste a display name for the bot, e.g. `Andy`.
```
```nc:env-set
MATRIX_BASE_URL={{base_url}}
MATRIX_USER_ID={{user_id}}
MATRIX_BOT_USERNAME={{bot_username}}
```

For **Option A** capture the bot login, for **Option B** capture the access
token — set only the block matching your chosen method:

```nc:prompt username
Option A only — the bot's login username (the localpart, e.g. `andybot`).
```
```nc:prompt password secret
Option A only — the bot account's password.
```
```nc:env-set
MATRIX_USERNAME={{username}}
MATRIX_PASSWORD={{password}}
```
```nc:prompt access_token secret
Option B only — the access token from Element Settings > Help & About, or from the login API.
```
```nc:env-set
MATRIX_ACCESS_TOKEN={{access_token}}
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `matrix`
- **terminology**: Matrix has "rooms." A room can be a group chat or a direct message. Rooms have internal IDs (like `!abc123:matrix.org`) and optional aliases (like `#general:matrix.org`).
- **how-to-find-id**: For DMs, use the bot's `openDM` to resolve the room automatically. For group rooms, in Element click the room name > Settings > Advanced — the "Internal room ID" is the platform ID (starts with `!`). Or use a room alias like `#general:matrix.org`.
- **supports-threads**: partial (some clients support threads, but not all — treat as no for reliability)
- **typical-use**: Interactive chat — rooms or direct messages. Requires a separate bot account (the agent cannot DM users from their own account).
- **default-isolation**: Same agent group for rooms where you're the primary user. Separate agent group for rooms with different communities or sensitive contexts.

## Troubleshooting

**Build fails with `ERR_MODULE_NOT_FOUND` for `matrix-js-sdk/lib/...`.** The ESM extension patch (step 4) hasn't been applied — or a later `pnpm install` reinstalled the adapter and wiped it. Re-run the patch, then `pnpm run build`; the patch is idempotent, so re-running is always safe.

**Login fails with `M_FORBIDDEN`.** The username/user-ID split is the usual trip: `MATRIX_USERNAME` is the bare localpart (`andybot`), while `MATRIX_USER_ID` is the full ID (`@andybot:matrix.org`) — swapping them fails auth. With Option B, an access token dies the moment that Element session signs out; grab a fresh one from Settings → Help & About → Access Token, or via the login API.

**The bot never joins your room.** Auto-join is on by default (`MATRIX_INVITE_AUTOJOIN=true`), but an allowlist (`MATRIX_INVITE_AUTOJOIN_ALLOWLIST`) that doesn't include your user ID makes it ignore your invites. Invite the bot from your own account and watch the service log for the join.

**Messages to yourself never arrive.** Matrix cannot DM your own account — the bot must be its own account, separate from yours. If you configured the adapter with your personal credentials, register a dedicated bot account and redo the credential steps.

**Registered but silent.** Run `pnpm exec vitest run src/channels/matrix-registration.test.ts` — red means the barrel import or the `@beeper/chat-adapter-matrix` install drifted, so re-run the Apply steps. If green, restart the service (see Next Steps) and check `logs/nanoclaw.error.log` for login errors.
