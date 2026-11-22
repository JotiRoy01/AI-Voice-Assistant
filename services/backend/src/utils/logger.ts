import pino from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-internal-token"]',
      '*.secret',
      '*.encrypted_secret',
      '*.password',
      '*.password_hash',
      '*.accessToken',
      '*.phone_e164',
    ],
    censor: '[REDACTED]',
  },
  base: {
    service: 'flowmind-voice-backend',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
