import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  ClientMsgSchema,
  CommandAckStatus,
  LatLngSchema,
  ServerMsgSchema,
  type ClientMsg,
  type LatLng,
  type ServerMsg,
} from '../gen/tracking/v2/messages_pb.js';
import type { LatLngInput } from './types.js';

export function toLatLng(input: LatLngInput): LatLng {
  return create(LatLngSchema, {
    latitude: input.latitude,
    longitude: input.longitude,
    altitude: input.altitude,
    accuracy: input.accuracy,
    heading: input.heading,
    speed: input.speed,
    timestampMs:
      input.timestampMs === undefined
        ? BigInt(Date.now())
        : typeof input.timestampMs === 'bigint'
          ? input.timestampMs
          : BigInt(input.timestampMs),
  });
}

export function encodeClientMsg(msg: ClientMsg): Uint8Array {
  return toBinary(ClientMsgSchema, msg);
}

export function decodeServerMsg(data: Uint8Array): ServerMsg {
  return fromBinary(ServerMsgSchema, data);
}

export function clientPing(): ClientMsg {
  return create(ClientMsgSchema, { body: { case: 'ping', value: {} } });
}

export function clientResume(trackUid: string, lastClientSeq: bigint): ClientMsg {
  return create(ClientMsgSchema, {
    body: {
      case: 'resume',
      value: { trackUid, lastClientSeq },
    },
  });
}

export function clientTrackStart(
  location?: LatLngInput,
  route?: LatLngInput[],
  metadata?: Uint8Array,
): ClientMsg {
  return create(ClientMsgSchema, {
    body: {
      case: 'trackStart',
      value: {
        location: location ? toLatLng(location) : undefined,
        route: (route ?? []).map(toLatLng),
        metadata: metadata ?? new Uint8Array(),
      },
    },
  });
}

export function clientTrackStop(trackUid: string): ClientMsg {
  return create(ClientMsgSchema, {
    body: { case: 'trackStop', value: { trackUid } },
  });
}

export function clientLocationAdd(
  trackUid: string,
  clientSeq: bigint,
  point: LatLngInput,
): ClientMsg {
  return create(ClientMsgSchema, {
    body: {
      case: 'locationAdd',
      value: { trackUid, clientSeq, point: toLatLng(point) },
    },
  });
}

export function clientLocationBatch(
  trackUid: string,
  clientSeq: bigint,
  points: LatLngInput[],
): ClientMsg {
  return create(ClientMsgSchema, {
    body: {
      case: 'locationBatch',
      value: {
        trackUid,
        clientSeq,
        points: points.map(toLatLng),
      },
    },
  });
}

export function clientSubscribe(
  deviceUid: string,
  opts?: { includeEvents?: boolean; minLocationIntervalMs?: number },
): ClientMsg {
  return create(ClientMsgSchema, {
    body: {
      case: 'subscribe',
      value: {
        deviceUid,
        includeEvents: opts?.includeEvents,
        minLocationIntervalMs: opts?.minLocationIntervalMs ?? 0,
      },
    },
  });
}

export function clientCommandAck(
  commandId: string,
  status: 'ok' | 'rejected' | 'failed' = 'ok',
  message?: string,
): ClientMsg {
  const statusMap = {
    ok: CommandAckStatus.OK,
    rejected: CommandAckStatus.REJECTED,
    failed: CommandAckStatus.FAILED,
  } as const;
  return create(ClientMsgSchema, {
    body: {
      case: 'commandAck',
      value: {
        commandId,
        status: statusMap[status],
        message,
      },
    },
  });
}

export function clientUnsubscribe(deviceUid: string): ClientMsg {
  return create(ClientMsgSchema, {
    body: { case: 'unsubscribe', value: { deviceUid } },
  });
}

export function clientEvent(
  trackUid: string,
  payload: Uint8Array,
  timestampMs?: number | bigint,
): ClientMsg {
  return create(ClientMsgSchema, {
    body: {
      case: 'event',
      value: {
        trackUid,
        payload,
        timestampMs:
          timestampMs === undefined
            ? BigInt(Date.now())
            : typeof timestampMs === 'bigint'
              ? timestampMs
              : BigInt(timestampMs),
      },
    },
  });
}

export function encodeServerMsg(msg: ServerMsg): Uint8Array {
  return toBinary(ServerMsgSchema, msg);
}

export function createServerMsg(
  body: NonNullable<ServerMsg['body']>,
): ServerMsg {
  return create(ServerMsgSchema, { body });
}

export function messageBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }
  throw new Error('expected binary WebSocket frame');
}
