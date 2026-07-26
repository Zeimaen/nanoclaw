/**
 * scripts/matrix-e2ee-rotate-device.ts — run before restarting the NanoClaw
 * host if any Matrix instance has E2EE enabled (MATRIX_RECOVERY_KEY set).
 *
 * Why this exists: the Matrix crypto store is memory-only (see
 * forceInMemoryE2EEStore in src/channels/matrix.ts — Node/Bun have no
 * IndexedDB, and that's the library's only persistent option). Every host
 * restart generates a fresh device identity keypair but reuses the
 * configured MATRIX_DEVICE_ID, and Matrix device identity keys are
 * immutable once the homeserver has accepted a /keys/upload for that
 * device_id — so the second boot with the same device ID always fails with
 * 400 M_BAD_JSON ("device_id in device_keys does not match"). This script
 * rolls MATRIX_DEVICE_ID to a fresh value and clears the stale persisted
 * session so the next boot logs in clean. wrapWithSelfCrossSigning then
 * re-verifies the new device automatically — no manual verification step.
 *
 * Usage:
 *   pnpm exec tsx scripts/matrix-e2ee-rotate-device.ts [--instance matrix] [--restart]
 *
 * --instance defaults to "matrix" (the unsuffixed, first-configured
 * instance). Pass "matrix2", "matrix3", etc. for additional instances
 * registered via MATRIX2_*, MATRIX3_*, ... env vars.
 * --restart additionally runs `systemctl --user restart` on this install's
 * unit once the prep is done; omit it to just prep and print the command.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { getSystemdUnit } from '../src/install-slug.js';

const PROJECT_ROOT = process.cwd();

const args = process.argv.slice(2);
const instanceFlagIdx = args.indexOf('--instance');
const instance = instanceFlagIdx !== -1 ? args[instanceFlagIdx + 1] : 'matrix';
const shouldRestart = args.includes('--restart');

if (!instance) {
  console.error('Usage: pnpm exec tsx scripts/matrix-e2ee-rotate-device.ts [--instance matrix] [--restart]');
  process.exit(2);
}

const envPrefix = `${instance.toUpperCase()}_`;
const deviceIdKey = `${envPrefix}DEVICE_ID`;
const envPath = path.join(PROJECT_ROOT, '.env');

if (!fs.existsSync(envPath)) {
  console.error(`No .env found at ${envPath}. Run this from the NanoClaw project root.`);
  process.exit(1);
}

const envLines = fs.readFileSync(envPath, 'utf-8').split('\n');
const lineIdx = envLines.findIndex((line) => line.trim().startsWith(`${deviceIdKey}=`));

if (lineIdx === -1) {
  console.error(
    `${deviceIdKey} not found in .env — is E2EE enabled for instance "${instance}"? ` +
      `(set MATRIX_RECOVERY_KEY / ${deviceIdKey} first if this is a first-time setup)`,
  );
  process.exit(1);
}

const currentValue = envLines[lineIdx].slice(envLines[lineIdx].indexOf('=') + 1).trim();

function nextDeviceId(current: string): string {
  const match = current.match(/^(.*?)(\d+)$/);
  if (match) {
    const [, prefix, digits] = match;
    const incremented = (parseInt(digits, 10) + 1).toString().padStart(digits.length, '0');
    return `${prefix}${incremented}`;
  }
  // No numeric suffix to increment — append a short random one so this
  // is still guaranteed to be a device ID the homeserver has never seen.
  return `${current}-${Math.random().toString(16).slice(2, 6)}`;
}

const newValue = nextDeviceId(currentValue);
envLines[lineIdx] = `${deviceIdKey}=${newValue}`;
fs.writeFileSync(envPath, envLines.join('\n'));
console.log(`${deviceIdKey}: ${currentValue} -> ${newValue}`);

// Clear the persisted session for this instance so the next boot does a
// genuinely fresh login bound to the new device, rather than reusing an
// access token tied to the old (about-to-be-abandoned) device. Also sweep
// that device's per-device sync-store cache (matrix:store:<deviceId>:*) —
// it's keyed by device ID, so it's already permanently orphaned the moment
// the device ID rotates, and would otherwise accumulate forever.
const db = new Database(path.join(DATA_DIR, 'v2.db'));
try {
  const result = db
    .prepare(`DELETE FROM chat_sdk_kv WHERE key LIKE ? OR key LIKE ? OR key LIKE ?`)
    .run(`${instance}:session:%`, `${instance}:device:%`, `${instance}:store:%:${currentValue}:%`);
  console.log(`Cleared ${result.changes} persisted session/store row(s) for instance "${instance}".`);
} finally {
  db.close();
}

const unit = `${getSystemdUnit(PROJECT_ROOT)}.service`;

if (shouldRestart) {
  console.log(`Restarting systemctl --user unit ${unit} ...`);
  execFileSync('systemctl', ['--user', 'restart', unit], { stdio: 'inherit' });
  console.log('Restarted. Self-cross-signing re-verifies the new device automatically — no manual step needed.');
} else {
  console.log(`Ready. Restart with: systemctl --user restart ${unit}`);
}
