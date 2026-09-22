export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'deleted',
  'conflict',
  'quota_exceeded',
  'plan_required',
  'validation',
  'rate_limited',
  'provider_disconnected',
  'network',
  'timeout',
  'unavailable',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  deleted: 410,
  conflict: 409,
  quota_exceeded: 402,
  plan_required: 402,
  validation: 422,
  rate_limited: 429,
  provider_disconnected: 424,
  network: 503,
  timeout: 504,
  unavailable: 503,
  internal: 500,
};

export interface AppErrorJSON {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }

  toJSON(): AppErrorJSON {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }

  static from(value: unknown): AppError {
    if (value instanceof AppError) return value;
    if (isAppErrorJSON(value)) return new AppError(value.code, value.message, value.details);
    if (value instanceof Error && value.name === 'AbortError')
      return new AppError('timeout', 'The request was cancelled or timed out.');
    return new AppError('internal', 'Something went wrong.', {
      cause: value instanceof Error ? value.message : String(value),
    });
  }
}

export function isAppErrorJSON(value: unknown): value is AppErrorJSON {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    (ERROR_CODES as readonly string[]).includes((value as { code: string }).code) &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

/** Human, non-technical copy for each error class. Used by UI toasts and inline errors. */
export function describeError(error: AppError | AppErrorJSON): string {
  switch (error.code) {
    case 'unauthorized':
      return 'Your session expired. Please sign in again.';
    case 'forbidden':
      return "You don't have permission to do that.";
    case 'not_found':
      return "We couldn't find that item. It may have been moved or you may have lost access.";
    case 'deleted':
      return 'This item was deleted.';
    case 'conflict':
      return 'Someone else changed this at the same time. We kept the latest version.';
    case 'quota_exceeded':
    case 'plan_required':
      return error.message || 'This needs a plan upgrade.';
    case 'validation':
      return error.message || 'Please check the highlighted fields.';
    case 'rate_limited':
      return "You're going a little fast. Please try again in a moment.";
    case 'provider_disconnected':
      return error.message || 'The connected account needs to be reconnected.';
    case 'network':
      return "You're offline. Changes are saved on this device and will sync later.";
    case 'timeout':
      return 'That took too long. Please try again.';
    case 'unavailable':
      return error.message || 'This feature is not available right now.';
    default:
      return 'Something went wrong on our side. Please try again.';
  }
}
