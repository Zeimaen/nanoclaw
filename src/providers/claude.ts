/**
 * Host-side container config for the `claude` provider.
 *
 * The agent-runner reads CLAUDE_CODE_AUTO_COMPACT_WINDOW from the container
 * env, which the host builds from scratch. Pass the operator's value through
 * (service env, else `.env`, which the host does not load into process.env).
 *
 * Claude Code's own telemetry/error-reporting opt-outs travel the same way:
 * set any of PRIVACY_KEYS to `1`/`true` in `.env` and every Claude agent
 * container gets it on its next spawn.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

/** Claude Code opt-out switches, passed through only when turned on. */
export const PRIVACY_KEYS = [
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
] as const;

registerProviderContainerConfig('claude', (ctx) => {
  const fromFile = readEnvFile([KEY, ...PRIVACY_KEYS]);
  const read = (k: string): string | undefined => ctx.hostEnv[k]?.trim() || fromFile[k]?.trim();
  const env: Record<string, string> = {};

  for (const k of PRIVACY_KEYS) {
    if (['1', 'true'].includes((read(k) ?? '').toLowerCase())) env[k] = '1';
  }

  const value = read(KEY);
  if (value) {
    if (/^[1-9]\d*$/.test(value)) env[KEY] = value;
    else log.warn(`Ignoring ${KEY}: expected a positive integer token count`, { value });
  }

  return Object.keys(env).length ? { env } : {};
});
