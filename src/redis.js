import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

export const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 2000),
});

redis.on('connect', () => console.log('✅ Redis conectado'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

// Lua: INCR atómico + EXPIRE solo en el primer hit
const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

/**
 * Rate limit por ventana fija, atómico (INCR + EXPIRE en Lua).
 */
export async function rateLimit(key, max, windowSec) {
  try {
    const current = await redis.eval(RATE_LIMIT_LUA, 1, key, String(windowSec));
    return { allowed: current <= max, remaining: Math.max(0, max - current) };
  } catch (err) {
    console.error('❌ rateLimit error:', err.message);
    // Fail-open controlado: si Redis falla, no bloqueamos al usuario
    return { allowed: true, remaining: max };
  }
}

/**
 * Cooldown por usuario usando TTL.
 */
export async function cooldown(key, ttlMs) {
  const res = await redis.set(key, '1', 'PX', ttlMs, 'NX');
  return res === 'OK';
}