/**
 * Matrix voice notes — send Ogg/Opus uploads as voice messages, not files.
 *
 * Fork-owned, deliberately kept out of matrix.ts: `/update-nanoclaw`'s skill
 * refresh overwrites matrix.ts with the channels-branch baseline, but leaves
 * files the payload doesn't ship alone. Only the one `wrapWithVoiceNotes(...)`
 * call in matrix.ts needs restoring after a refresh.
 *
 * Two gaps make an agent's .ogg arrive as a plain file bubble:
 *   1. The Chat SDK bridge forwards `{ data, filename }` with no mimeType, so
 *      `@beeper/chat-adapter-matrix` picks `msgtype: m.file`.
 *   2. Even with `m.audio`, Element/clients only render the voice-note bubble
 *      when the event carries `org.matrix.msc3245.voice` plus the MSC1767
 *      audio block (duration + waveform).
 *
 * The wrapper sniffs each outgoing file: if it is an Ogg stream carrying Opus
 * (the voice-note codec), it sets mimeType `audio/ogg` before the adapter
 * builds the event (so the upload and msgtype are right), then adds duration,
 * a waveform and the voice marker to the resulting `m.audio` content.
 *
 * Duration comes from the last Ogg page's granule position minus the Opus
 * pre-skip (exact, 48 kHz clock). There is no Opus decoder on the host, so the
 * waveform is approximated from per-packet sizes: Opus VBR spends few bytes on
 * silence and more on speech, which is enough for the bubble's visual shape.
 */
import type { createMatrixAdapter } from '@beeper/chat-adapter-matrix';

const VOICE_EXTENSIONS = /\.(ogg|oga|opus)$/i;
const WAVEFORM_POINTS = 100;
const WAVEFORM_MAX = 1024;

export interface VoiceNoteMeta {
  durationMs: number;
  waveform: number[];
}

interface OggPage {
  granule: bigint;
  segments: number[];
  bodyStart: number;
}

function readOggPages(buf: Buffer): OggPage[] {
  const pages: OggPage[] = [];
  let pos = 0;
  while (pos + 27 <= buf.length) {
    if (buf.toString('latin1', pos, pos + 4) !== 'OggS') return pages;
    const granule = buf.readBigInt64LE(pos + 6);
    const segmentCount = buf[pos + 26];
    const tableEnd = pos + 27 + segmentCount;
    if (tableEnd > buf.length) return pages;
    const segments = [...buf.subarray(pos + 27, tableEnd)];
    pages.push({ granule, segments, bodyStart: tableEnd });
    pos = tableEnd + segments.reduce((sum, len) => sum + len, 0);
  }
  return pages;
}

/** Packet sizes in stream order. A packet ends on a lacing value < 255. */
function packetSizes(pages: OggPage[]): number[] {
  const sizes: number[] = [];
  let current = 0;
  for (const page of pages) {
    for (const len of page.segments) {
      current += len;
      if (len < 255) {
        sizes.push(current);
        current = 0;
      }
    }
  }
  return sizes;
}

function waveformFromPackets(sizes: number[]): number[] {
  if (sizes.length === 0) return [];
  const points = Math.min(WAVEFORM_POINTS, sizes.length);
  const buckets: number[] = [];
  for (let i = 0; i < points; i++) {
    const start = Math.floor((i * sizes.length) / points);
    const end = Math.max(start + 1, Math.floor(((i + 1) * sizes.length) / points));
    const slice = sizes.slice(start, end);
    buckets.push(slice.reduce((sum, n) => sum + n, 0) / slice.length);
  }
  const min = Math.min(...buckets);
  const max = Math.max(...buckets);
  if (max === min) return buckets.map(() => WAVEFORM_MAX);
  return buckets.map((v) => Math.round(((v - min) / (max - min)) * WAVEFORM_MAX));
}

/**
 * Returns voice-note metadata when `data` is an Ogg/Opus stream with a
 * voice-note file extension, otherwise null (send it the normal way).
 */
export function analyzeVoiceNote(filename: string, data: Buffer): VoiceNoteMeta | null {
  if (!VOICE_EXTENSIONS.test(filename)) return null;
  const pages = readOggPages(data);
  if (pages.length < 2) return null;

  const head = data.subarray(pages[0].bodyStart, pages[0].bodyStart + 19);
  if (head.toString('latin1', 0, 8) !== 'OpusHead' || head.length < 12) return null;
  const preSkip = head.readUInt16LE(10);

  const lastGranule = pages[pages.length - 1].granule;
  const samples = Number(lastGranule) - preSkip;
  if (!Number.isFinite(samples) || samples <= 0) return null;

  // First two packets are the OpusHead and OpusTags headers, not audio.
  const audioPackets = packetSizes(pages).slice(2);
  return {
    durationMs: Math.round(samples / 48),
    waveform: waveformFromPackets(audioPackets),
  };
}

type MatrixAdapter = ReturnType<typeof createMatrixAdapter>;
type RoomContent = Record<string, unknown> & { body?: unknown; msgtype?: unknown; info?: Record<string, unknown> };

export function wrapWithVoiceNotes(adapter: MatrixAdapter): MatrixAdapter {
  const internal = adapter as unknown as {
    toRoomMessageContents: (message: unknown) => Promise<RoomContent[]>;
  };
  const orig = internal.toRoomMessageContents.bind(adapter);

  internal.toRoomMessageContents = async (message: unknown): Promise<RoomContent[]> => {
    const voice = new Map<string, VoiceNoteMeta>();
    const files = (message as { files?: unknown } | null)?.files;
    if (Array.isArray(files)) {
      for (const file of files as Array<{ filename?: unknown; data?: unknown; mimeType?: unknown }>) {
        if (typeof file?.filename !== 'string' || !(file.data instanceof Uint8Array)) continue;
        const meta = analyzeVoiceNote(file.filename, Buffer.from(file.data));
        if (!meta) continue;
        voice.set(file.filename, meta);
        file.mimeType = 'audio/ogg';
      }
    }

    const contents = await orig(message);
    if (voice.size === 0) return contents;

    return contents.map((content) => {
      const meta = typeof content.body === 'string' ? voice.get(content.body) : undefined;
      if (!meta || content.msgtype !== 'm.audio') return content;
      return {
        ...content,
        info: { ...content.info, mimetype: 'audio/ogg', duration: meta.durationMs },
        'org.matrix.msc1767.audio': { duration: meta.durationMs, waveform: meta.waveform },
        'org.matrix.msc3245.voice': {},
      };
    });
  };

  return adapter;
}
