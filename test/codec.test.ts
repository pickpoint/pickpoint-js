import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  clientResume,
  decodeClientMsg,
  decodeServerMsg,
  encodeClientMsg,
  encodeLocFrames,
  encodeServerMsg,
  hexToBytes,
  microDeltaFits,
  toLatLng,
} from '@pickpoint/sdk/tracking';

const GOLDEN_UUID = '00112233-4455-6677-8899-aabbccddeeff';

function hex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

describe('codec', () => {
  it('toLatLng omits timestamp unless provided (live Loc)', () => {
    const p = toLatLng({ latitude: 1, longitude: 2 });
    expect(p.timestampMs).toBeUndefined();
    expect(p).not.toHaveProperty('heading');
    expect(p).not.toHaveProperty('speed');
  });

  it('preserves explicit timestampMs', () => {
    const p = toLatLng({ latitude: 1, longitude: 2, timestampMs: 42 });
    expect(p.timestampMs).toBe(42);
  });

  it('golden Ack seq=1', () => {
    const bytes = encodeServerMsg({ type: 'ack', seq: 1 });
    expect(hex(bytes)).toBe('8501000000');
    expect(decodeServerMsg(hexToBytes('85 01 00 00 00'))).toEqual({
      type: 'ack',
      seq: 1,
    });
  });

  it('golden Loc 55N 37E seq=1', () => {
    const bytes = encodeClientMsg({
      type: 'loc',
      seq: 1,
      points: [{ latitude: 55, longitude: 37 }],
    });
    expect(hex(bytes)).toBe('04010000000100c03b470340933402');
    const decoded = decodeClientMsg(
      hexToBytes('04 01 00 00 00 01 00 c0 3b 47 03 40 93 34 02'),
    );
    expect(decoded.type).toBe('loc');
    if (decoded.type === 'loc') {
      expect(decoded.seq).toBe(1);
      expect(decoded.points).toHaveLength(1);
      expect(decoded.points[0]!.latitude).toBeCloseTo(55);
      expect(decoded.points[0]!.longitude).toBeCloseTo(37);
    }
  });

  it('golden Resume uuid last_seq=45', () => {
    const bytes = encodeClientMsg(clientResume(GOLDEN_UUID, 45));
    expect(hex(bytes)).toBe(
      '0100112233445566778899aabbccddeeff2d000000',
    );
    const decoded = decodeClientMsg(
      hexToBytes(
        '01 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff 2d 00 00 00',
      ),
    );
    expect(decoded).toEqual({
      type: 'resume',
      trackUid: GOLDEN_UUID,
      lastSeq: 45,
    });
  });

  it('golden TrackStop', () => {
    expect(hex(encodeClientMsg({ type: 'trackStop' }))).toBe('03');
  });

  it('round-trips ServerMsg hello', () => {
    const msg = {
      type: 'hello' as const,
      version: 2,
      shard: 7,
      nodeId: '01234567-89ab-cdef-0123-456789abcdef',
    };
    expect(decodeServerMsg(encodeServerMsg(msg))).toEqual(msg);
  });

  it('ignores unknown server type (forward compatible)', () => {
    expect(decodeServerMsg(new Uint8Array([0x8d, 0x00]))).toBeNull();
  });

  it('splits Loc frames when intra-frame Δ overflows i16 (never wraps)', () => {
    const a = { latitude: 55, longitude: 37 };
    const b = { latitude: 56, longitude: 37 };
    expect(
      microDeltaFits(
        Math.round(55e6),
        Math.round(37e6),
        Math.round(56e6),
        Math.round(37e6),
      ),
    ).toBe(false);

    const frames = encodeLocFrames(2, [a, b]);
    expect(frames).toHaveLength(2);
    const first = decodeClientMsg(frames[0]!);
    const second = decodeClientMsg(frames[1]!);
    expect(first).toMatchObject({ type: 'loc', seq: 1 });
    expect(second).toMatchObject({ type: 'loc', seq: 2 });
    if (first.type === 'loc' && second.type === 'loc') {
      expect(first.points).toHaveLength(1);
      expect(second.points).toHaveLength(1);
      expect(first.points[0]!.latitude).toBeCloseTo(55);
      expect(second.points[0]!.latitude).toBeCloseTo(56);
    }
  });

  it('batches consecutive points that fit in i16 Δ', () => {
    const a = { latitude: 55, longitude: 37 };
    const b = { latitude: 55.00001, longitude: 37 };
    const frames = encodeLocFrames(2, [a, b]);
    expect(frames).toHaveLength(1);
    const d = decodeClientMsg(frames[0]!);
    expect(d.type).toBe('loc');
    if (d.type === 'loc') {
      expect(d.seq).toBe(2);
      expect(d.points).toHaveLength(2);
      expect(d.points[1]!.latitude).toBeCloseTo(55.00001, 5);
    }
  });
});
