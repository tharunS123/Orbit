import pino, { type Logger } from 'pino';

/**
 * Structured logging. Secrets and private content are redacted by path; callers must never log
 * raw tokens, passwords, document bodies or transcripts.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'access_token',
  '*.access_token',
  'refresh_token',
  '*.refresh_token',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
  'secret',
  '*.secret',
  'body',
  '*.body',
  'transcript',
  '*.transcript',
  'content',
  '*.content',
];

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info', name = 'orbit'): Logger {
  return pino({
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

export type { Logger };
