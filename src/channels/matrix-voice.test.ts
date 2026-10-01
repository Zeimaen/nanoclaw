import { describe, expect, it } from 'vitest';

import { analyzeVoiceNote, wrapWithVoiceNotes } from './matrix-voice.js';

/** One Ogg page: header + lacing table + body. CRC is not checked by the parser. */
function oggPage(granule: bigint, packets: Buffer[]): Buffer {
  const lacing: number[] = [];
  for (const packet of packets) {
    let left = packet.length;
    while (left >= 255) {
      lacing.push(255);
      left -= 255;
    }
    lacing.push(left);
  }
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'latin1');
  header.writeBigInt64LE(granule, 6);
  header[26] = lacing.length;
  return Buffer.concat([header, Buffer.from(lacing), ...packets]);
}

/** Minimal Ogg/Opus stream: OpusHead, OpusTags, then audio packets of the given sizes. */
function opusStream(preSkip: number, endGranule: bigint, audioPacketSizes: number[]): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48000, 12);
  const tags = Buffer.from('OpusTags\0\0\0\0\0\0\0\0', 'latin1');
  const audio = audioPacketSizes.map((n) => Buffer.alloc(n, 1));
  return Buffer.concat([oggPage(0n, [head]), oggPage(0n, [tags]), oggPage(endGranule, audio)]);
}

describe('analyzeVoiceNote', () => {
  it('reads duration from the last granule minus pre-skip', () => {
    // 2.5 s at 48 kHz plus a 312-sample pre-skip.
    const meta = analyzeVoiceNote('note.ogg', opusStream(312, 120_312n, [10, 80, 80, 10]));
    expect(meta?.durationMs).toBe(2500);
  });

  it('derives a 0..1024 waveform from audio packet sizes, skipping header packets', () => {
    const meta = analyzeVoiceNote('note.opus', opusStream(0, 48_000n, [5, 300, 5]));
    expect(meta?.waveform).toEqual([0, 1024, 0]);
  });

  it('ignores non-voice extensions, non-Ogg data and non-Opus Ogg', () => {
    const opus = opusStream(0, 48_000n, [10]);
    expect(analyzeVoiceNote('note.mp3', opus)).toBeNull();
    expect(analyzeVoiceNote('note.ogg', Buffer.from('not an ogg file'))).toBeNull();
    const vorbis = Buffer.concat([oggPage(0n, [Buffer.from('\x01vorbis-header-here', 'latin1')]), oggPage(1n, [])]);
    expect(analyzeVoiceNote('note.ogg', vorbis)).toBeNull();
  });
});

describe('wrapWithVoiceNotes', () => {
  function fakeAdapter() {
    const seen: Array<{ filename: string; mimeType?: string }> = [];
    const adapter = {
      // Mirrors the adapter: msgtype follows the file's mimeType.
      async toRoomMessageContents(message: { files: Array<{ filename: string; mimeType?: string }> }) {
        seen.push(...message.files.map((f) => ({ ...f })));
        return message.files.map((f) => ({
          body: f.filename,
          msgtype: f.mimeType?.startsWith('audio/') ? 'm.audio' : 'm.file',
          url: 'mxc://example/abc',
          info: { mimetype: f.mimeType, size: 1 },
        }));
      },
    };
    return { adapter, seen };
  }

  it('sends Ogg/Opus as an m.audio voice note and leaves other files alone', async () => {
    const { adapter, seen } = fakeAdapter();
    wrapWithVoiceNotes(adapter as never);
    const contents = await adapter.toRoomMessageContents({
      files: [
        { filename: 'reply.ogg', data: opusStream(0, 96_000n, [10, 200]) } as never,
        { filename: 'notes.txt', data: Buffer.from('hi') } as never,
      ],
    });

    expect(seen.map((f) => f.mimeType)).toEqual(['audio/ogg', undefined]);
    expect(contents[0]).toMatchObject({
      msgtype: 'm.audio',
      info: { mimetype: 'audio/ogg', duration: 2000 },
      'org.matrix.msc1767.audio': { duration: 2000, waveform: [0, 1024] },
      'org.matrix.msc3245.voice': {},
    });
    expect(contents[1]).toEqual({
      body: 'notes.txt',
      msgtype: 'm.file',
      url: 'mxc://example/abc',
      info: { mimetype: undefined, size: 1 },
    });
  });
});
