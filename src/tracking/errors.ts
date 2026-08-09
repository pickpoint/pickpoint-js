import { ErrorCode } from '../gen/tracking/v2/messages_pb.js';
import type { TrackingError } from './types.js';

export class TrackingSdkError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message || ErrorCode[code] || 'tracking error');
    this.name = 'TrackingSdkError';
    this.code = code;
  }

  static fromWire(err: TrackingError): TrackingSdkError {
    return new TrackingSdkError(err.code, err.message);
  }
}

export function isFatalResumeError(code: ErrorCode): boolean {
  return (
    code === ErrorCode.TRACK_NOT_FOUND ||
    code === ErrorCode.FENCED ||
    code === ErrorCode.AUTH ||
    code === ErrorCode.UNAUTHORIZED
  );
}
