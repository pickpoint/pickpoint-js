import { create, fromBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  ClientMsgSchema,
  ServerMsgSchema,
  clientResume,
  decodeServerMsg,
  encodeClientMsg,
  encodeServerMsg,
  toLatLng,
} from '@pickpoint/sdk/tracking';

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
    const p = toLatLng({ latitude: 1, longitude: 2, timestampMs: 42 });
    expect(p.timestampMs).toBe(42n);
  });

  it('round-trips ClientMsg resume', () => {
    const msg = clientResume('t1', 9n);
    const d = fromBinary(ClientMsgSchema, encodeClientMsg(msg));
    expect(d.body.case).toBe('resume');
    if (d.body.case === 'resume') {
      expect(d.body.value.trackUid).toBe('t1');
      expect(d.body.value.lastClientSeq).toBe(9n);
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
