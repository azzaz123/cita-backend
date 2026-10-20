import pino from 'pino';
import dotenv from 'dotenv';
dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';
const wantsLogtail = !!process.env.LOGTAIL_TOKEN;

export const logger = (() => {
  if (isProduction && wantsLogtail) {
    try {
      return pino(
        { level: process.env.LOG_LEVEL || 'info' },
        pino.transport({
          targets: [
            {
              target: '@logtail/pino',
              options: { sourceToken: process.env.LOGTAIL_TOKEN },
              level: 'info',
            },
            {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'HH:MM:ss' },
              level: 'debug',
            },
          ],
        })
      );
    } catch (err) {
      console.warn('⚠️ Fallback a pino-pretty:', err.message);
    }
  }

  return pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  });
})();