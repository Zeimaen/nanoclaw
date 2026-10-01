/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. group threads:true matches the
 * declared supportsThreads (the skill-installed install-style knob) so
 * mention-sticky engagement stays bounded per-thread. dm.threads:false —
 * DM replies land top-level, one session per DM.
 */
const DISCORD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Discord message forwards carry their content in `message_snapshots`, not
 * `content` (`message_reference.type === 1` means FORWARD; 0 is a normal
 * reply). The adapter only reads `content`/`attachments`, so without this the
 * agent sees an empty message. Unwrap the snapshot back into the payload so
 * text, attachment download, and formatting all ride the existing path.
 * Note: snapshots contain no author, so the original sender is unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapForwardedSnapshot(data: Record<string, any>): void {
  if (data.message_reference?.type !== 1) return;
  const snaps = (data.message_snapshots ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any) => s?.message)
    .filter(Boolean);
  if (snaps.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = snaps
    .map((m: any) => m.content)
    .filter(Boolean)
    .join('\n');
  const label = '[Forwarded message]';
  data.content = text ? `${label}\n${text}` : data.content || label;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fwdAttachments = snaps.flatMap((m: any) => m.attachments ?? []);
  if (fwdAttachments.length > 0) {
    data.attachments = [...(data.attachments ?? []), ...fwdAttachments];
  }
}

function unwrapForwards(adapter: ReturnType<typeof createDiscordAdapter>): void {
  const a = adapter as unknown as {
    handleForwardedMessage: (data: Record<string, unknown>, options?: unknown) => Promise<void>;
  };
  const orig = a.handleForwardedMessage.bind(adapter);
  a.handleForwardedMessage = async (data, options) => {
    unwrapForwardedSnapshot(data);
    return orig(data, options);
  };
}

/**
 * Registers one Discord bot app under a registry key. `instance` is passed
 * through to the chat-sdk bridge so N separate bot applications can run side
 * by side (each gets its own registry/activeAdapters key, webhook route, and
 * state namespace — see chat-sdk-bridge.ts). The default instance stays
 * `undefined` so single-bot installs are unaffected (keyed by channelType).
 * `envPrefix` lets each instance read its own token/app-id/public-key trio
 * instead of colliding on the same three env vars.
 */
function registerDiscordInstance(registryName: string, instance: string | undefined, envPrefix: string): void {
  registerChannelAdapter(registryName, {
    factory: () => {
      const env = readEnvFile([`${envPrefix}BOT_TOKEN`, `${envPrefix}PUBLIC_KEY`, `${envPrefix}APPLICATION_ID`]);
      const botToken = env[`${envPrefix}BOT_TOKEN`];
      if (!botToken) return null;
      const discordAdapter = createDiscordAdapter({
        botToken,
        publicKey: env[`${envPrefix}PUBLIC_KEY`],
        applicationId: env[`${envPrefix}APPLICATION_ID`],
      });
      unwrapForwards(discordAdapter);
      return createChatSdkBridge({
        adapter: discordAdapter,
        concurrency: 'concurrent',
        botToken,
        instance,
        extractReplyContext,
        supportsThreads: true,
        defaults: DISCORD_DEFAULTS,
        // Discord rejects messages over 2000 chars; without this the bridge
        // would let long agent replies fail instead of splitting them.
        maxTextLength: 2000,
      });
    },
    defaults: DISCORD_DEFAULTS,
  });
}

registerDiscordInstance('discord', undefined, 'DISCORD_');
