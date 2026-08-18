import { ErrorCode, type TrackingError } from './types';

export class TrackingSdkError extends Error {
  readonly code: ErrorCode;
  readonly trackUid?: string;
  readonly retryAfterMs?: number;

  constructor(code: ErrorCode, message: string, extra?: {
    trackUid?: string;
    retryAfterMs?: number;
  }) {
    super(message || ErrorCode[code] || 'tracking error');
    this.name = 'TrackingSdkError';
    this.code = code;
    this.trackUid = extra?.trackUid;
    this.retryAfterMs = extra?.retryAfterMs;
  }

  static fromWire(err: TrackingError): TrackingSdkError {
    return new TrackingSdkError(err.code, err.message, {
      trackUid: err.trackUid,
      retryAfterMs: err.retryAfterMs,
    });
  }
}

/** Fatal for Resume: AUTH and TRACK_NOT_FOUND. FENCED / TRY_AGAIN are retried. */
export function isFatalResumeError(code: ErrorCode): boolean {
  return code === ErrorCode.TRACK_NOT_FOUND || code === ErrorCode.AUTH;
}
