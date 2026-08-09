import { create, fromBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  ClientMsgSchema,
  ServerMsgSchema,
} from '../src/gen/tracking/v2/messages_pb.js';
import {
  clientResume,
  decodeServerMsg,
  encodeClientMsg,
  encodeServerMsg,
  toLatLng,
} from '../src/tracking/codec.js';

describe('codec', () => {
  it('defaults timestampMs to Date.now() when omitted', () => {
    const before = Date.now();
    const p = toLatLng({ latitude: 1, longitude: 2 });
    const after = Date.now();
    expect(p.timestampMs).toBeDefined();
    const ts = Number(p.timestampMs);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('preserves explicit timestampMs', () => {
    const p = toLatLng({ latitude: 1, longitude: 2, timestampMs: 1_700_000_000_000 });
    expect(p.timestampMs).toBe(1_700_000_000_000n);
  });

  it('round-trips ClientMsg resume', () => {
    const bytes = encodeClientMsg(clientResume('trk-1', 42n));
    const d = fromBinary(ClientMsgSchema, bytes);
    expect(d.body.case).toBe('resume');
    if (d.body.case === 'resume') {
      expect(d.body.value.trackUid).toBe('trk-1');
      expect(d.body.value.lastClientSeq).toBe(42n);
    }
  });

  it('round-trips ServerMsg hello', () => {
    const msg = create(ServerMsgSchema, {
      body: { case: 'hello', value: { nodeId: 'n1', shard: 7 } },
    });
    const d = decodeServerMsg(encodeServerMsg(msg));
    expect(d.body.case).toBe('hello');
    if (d.body.case === 'hello') {
      expect(d.body.value.nodeId).toBe('n1');
      expect(d.body.value.shard).toBe(7);
    }
  });
});
