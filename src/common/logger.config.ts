import { WinstonModuleOptions } from 'nest-winston';
import * as winston from 'winston';

const PII_PATTERNS = [
  /\+233\d{9}/g, // Ghana phone numbers
  /GHA-\d{9}-\d/g, // Ghana Card numbers
  /\b[A-Z]{1}\d{10}\b/g, // TIN format
];

const redactPii = winston.format((info) => {
  let message = typeof info.message === 'string' ? info.message : '';
  for (const pattern of PII_PATTERNS) {
    message = message.replace(pattern, '[REDACTED]');
  }
  info.message = message;
  return info;
});

export const winstonConfig: WinstonModuleOptions = {
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        redactPii(),
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        process.env.NODE_ENV === 'production'
          ? winston.format.json()
          : winston.format.combine(
              winston.format.colorize(),
              winston.format.printf(
                ({ timestamp, level, message, ...meta }) => {
                  const metaStr = Object.keys(meta).length
                    ? ` ${JSON.stringify(meta)}`
                    : '';
                  return `${timestamp} [${level}] ${message}${metaStr}`;
                },
              ),
            ),
      ),
    }),
  ],
};
