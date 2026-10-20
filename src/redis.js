import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

export const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 2000),
});

redis.on('connect', () => console.log('✅ Redis conectado'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

/**
 * Rate limit por ventana deslizante simple.
 */
export async function rateLimit(key, max, windowSec) {
  const current = await redis.incr(key);
  if (current === 1) await redis.expire(key, windowSec);
  return { allowed: current <= max, remaining: Math.max(0, max - current) };
}

/**
 * Cooldown por usuario usando TTL.
 */
export async function cooldown(key, ttlMs) {
  const res = await redis.set(key, '1', 'PX', ttlMs, 'NX');
  return res === 'OK';
}