/**
 * scripts/matrix-e2ee-rotate-device.ts — run before restarting the NanoClaw
 * host if ANY Matrix instance has E2EE enabled (`<PREFIX>_RECOVERY_KEY` set).
 *
 * Wired in as an ExecStartPre (systemd) / ProgramArguments pre-step (launchd)
 * / leading step (nohup wrapper) by `setup/service.ts`, so every host start —
 * manual `systemctl`/`launchctl` restart, a reboot, and systemd's own
 * Restart=always crash-restart alike — runs this first automatically. No-op
 * (exits 0 immediately) when no instance has E2EE enabled. Manual invocation
 * is for troubleshooting only; you should not normally need to run this by
 * hand — if you find yourself doing so regularly, check that this install's
 * service config actually has the pre-step (re-run `/setup`'s service step,
 * or diff against a fresh `setup/service.ts` generation, to restore it).
 *
 * Why this exists: the Matrix crypto store is memory-only (see
 * forceInMemoryE2EEStore in src/channels/matrix.ts — Node/Bun have no
 * IndexedDB, and that's the library's only persistent option). Every host
 * restart generates a fresh device identity keypair but reuses the
 * configured `<PREFIX>_DEVICE_ID`, and Matrix device identity keys are
 * immutable once the homeserver has accepted a /keys/upload for that
 * device_id — so the second boot with the same device ID always fails with
 * 400 M_BAD_JSON ("device_id in device_keys does not match"). This script
 * rolls `<PREFIX>_DEVICE_ID` to a fresh value and clears the stale persisted
 * session so the next boot logs in clean. wrapWithSelfCrossSigning then
 * re-verifies the new device automatically — no manual verification step.
 *
 * Multi-instance: every E2EE-enabled Matrix instance shares this restart
 * fragility independently — rotating only one before a restart silently
 * burns any other instance's device. Default behavior (no --instance flags)
 * rotates every instance with a non-empty `<PREFIX>_RECOVERY_KEY` in .env,
 * auto-detected, so a restart can never accidentally skip one. All targeted
 * instances are validated and prepped together before a single restart —
 * never one restart per instance.
 *
 * Usage:
 *   pnpm exec tsx scripts/matrix-e2ee-rotate-device.ts [--instance matrix] [--instance matrix2] [--restart]
 *
 * --instance may be repeated to target specific instances instead of the
 * auto-detected set — e.g. a brand-new instance whose `<PREFIX>_DEVICE_ID`
 * you just added to .env for its first-ever E2EE boot (auto-detection still
 * requires the device-id line to exist, same as an explicit --instance).
 * --restart additionally runs `systemctl --user restart` on this install's
 * unit once every targeted instance is prepped.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { getSystemdUnit } from '../src/install-slug.js';

const PROJECT_ROOT = process.cwd();
const envPath = path.join(PROJECT_ROOT, '.env');

if (!fs.existsSync(envPath)) {
  console.error(`No .env found at ${envPath}. Run this from the NanoClaw project root.`);
  process.exit(1);
}

const args = process.argv.slice(2);
const shouldRestart = args.includes('--restart');
const explicitInstances = args.flatMap((arg, i) => (arg === '--instance' ? [args[i + 1]] : [])).filter(
  (v): v is string => Boolean(v),
);

const envLines = fs.readFileSync(envPath, 'utf-8').split('\n');

/** Every instance with a non-empty `<PREFIX>_RECOVERY_KEY` line in .env. */
function detectE2eeInstances(): string[] {
  const found = new Set<string>();
  for (const line of envLines) {
    const match = line.trim().match(/^([A-Z][A-Z0-9]*)_RECOVERY_KEY=(.*)$/);
    if (match && match[2]!.trim().length > 0) {
      found.add(match[1]!.toLowerCase());
    }
  }
  return [...found];
}

const instances = explicitInstances.length > 0 ? explicitInstances : detectE2eeInstances();

if (instances.length === 0) {
  console.log('No Matrix instance has E2EE enabled (no non-empty *_RECOVERY_KEY in .env) — nothing to rotate.');
  if (shouldRestart) {
    const unit = `${getSystemdUnit(PROJECT_ROOT)}.service`;
    console.log(`Restarting systemctl --user unit ${unit} ...`);
    execFileSync('systemctl', ['--user', 'restart', unit], { stdio: 'inherit' });
    console.log('Restarted.');
  }
  process.exit(0);
}

function nextDeviceId(current: string): string {
  const match = current.match(/^(.*?)(\d+)$/);
  if (match) {
    const [, prefix, digits] = match;
    const incremented = (parseInt(digits!, 10) + 1).toString().padStart(digits!.length, '0');
    return `${prefix}${incremented}`;
  }
  // No numeric suffix to increment — append a short random one so this
  // is still guaranteed to be a device ID the homeserver has never seen.
  return `${current}-${Math.random().toString(16).slice(2, 6)}`;
}

interface Rotation {
  instance: string;
  deviceIdKey: string;
  lineIdx: number;
  currentValue: string;
  newValue: string;
}

// Validate every targeted instance BEFORE touching anything — all-or-nothing,
// so a typo'd --instance or a missing device-id line for one instance never
// leaves .env half-rotated ahead of a restart.
const rotations: Rotation[] = [];
const errors: string[] = [];

for (const instance of instances) {
  const envPrefix = `${instance.toUpperCase()}_`;
  const deviceIdKey = `${envPrefix}DEVICE_ID`;
  const lineIdx = envLines.findIndex((line) => line.trim().startsWith(`${deviceIdKey}=`));
  if (lineIdx === -1) {
    errors.push(
      `${deviceIdKey} not found in .env — is E2EE enabled for instance "${instance}"? ` +
        `(set ${envPrefix}RECOVERY_KEY / ${deviceIdKey} first if this is a first-time setup)`,
    );
    continue;
  }
  const currentValue = envLines[lineIdx]!.slice(envLines[lineIdx]!.indexOf('=') + 1).trim();
  rotations.push({ instance, deviceIdKey, lineIdx, currentValue, newValue: nextDeviceId(currentValue) });
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

for (const r of rotations) {
  envLines[r.lineIdx] = `${r.deviceIdKey}=${r.newValue}`;
  console.log(`${r.deviceIdKey}: ${r.currentValue} -> ${r.newValue}`);
}
fs.writeFileSync(envPath, envLines.join('\n'));

// Clear each instance's persisted session so the next boot does a genuinely
// fresh login bound to the new device, rather than reusing an access token
// tied to the old (about-to-be-abandoned) device. Also sweep that device's
// per-device sync-store cache (<keyBase>:store:*:<deviceId>:*) — it's keyed
// by device ID, so it's already permanently orphaned the moment the device
// ID rotates, and would otherwise accumulate forever.
//
// Key namespacing is NOT simply "<instance>:" — chat-sdk-bridge.ts's
// SqliteStateAdapter only adds an outer "<instance>:" prefix when the
// NanoClaw instance name differs from the Chat SDK adapter's own hardcoded
// `name` (always the literal string "matrix" for every Matrix instance, see
// `name = "matrix"` in the vendored @beeper/chat-adapter-matrix). The
// DEFAULT instance is registered with `instance: undefined` specifically so
// it collapses onto that unprefixed legacy keyspace — its NanoClaw instance
// name ("matrix") equals the adapter name, so chat-sdk-bridge.ts adds no
// outer prefix, and the vendored package's OWN internal keyPrefix ("matrix",
// unconfigurable here) is all that shows up: keys look like "matrix:dm:...".
// Every OTHER instance (matrix2, matrix3, ...) gets the outer prefix ON TOP
// of that same inner "matrix:" — keys look like "matrix2:matrix:dm:...".
// Using "<instance>:session:%" unconditionally (the original bug) silently
// matched nothing for any non-default instance — confirmed live: it left a
// named instance's stale pre-rotation session in place, which the SDK then
// reused instead of doing the intended fresh login, so the "rotated" device
// ID never actually took effect on the homeserver.
function keyBase(instance: string): string {
  return instance === 'matrix' ? 'matrix' : `${instance}:matrix`;
}

const db = new Database(path.join(DATA_DIR, 'v2.db'));
try {
  for (const r of rotations) {
    const base = keyBase(r.instance);
    const result = db
      .prepare(`DELETE FROM chat_sdk_kv WHERE key LIKE ? OR key LIKE ? OR key LIKE ?`)
      .run(`${base}:session:%`, `${base}:device:%`, `${base}:store:%:${r.currentValue}:%`);
    console.log(`Cleared ${result.changes} persisted session/store row(s) for instance "${r.instance}".`);
  }
} finally {
  db.close();
}

const unit = `${getSystemdUnit(PROJECT_ROOT)}.service`;

if (shouldRestart) {
  console.log(`Restarting systemctl --user unit ${unit} ...`);
  execFileSync('systemctl', ['--user', 'restart', unit], { stdio: 'inherit' });
  console.log('Restarted. Self-cross-signing re-verifies the new device(s) automatically — no manual step needed.');
} else {
  console.log(`Ready. Restart with: systemctl --user restart ${unit}`);
}
