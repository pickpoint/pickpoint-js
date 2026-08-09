export class ApiError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly body?: unknown;

  constructor(
    message: string,
    opts?: { status?: number; code?: string; cause?: unknown; body?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ApiError';
    this.status = opts?.status;
    this.code = opts?.code ?? 'API_ERROR';
    this.body = opts?.body;
  }
}

export class ApiAuthError extends ApiError {
  constructor(message: string, status: number) {
    super(message, { status, code: 'API_AUTH' });
    this.name = 'ApiAuthError';
  }
}
