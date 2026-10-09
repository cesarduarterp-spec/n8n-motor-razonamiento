import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';

export function redisConnectionOptions() {
  const url = new URL(env().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null, // requerido por BullMQ
  };
}

/** Lock distribuido simple (SET NX PX + liberación segura con token). */
@Injectable()
export class RedisLock implements OnModuleDestroy {
  private readonly redis = new Redis(redisConnectionOptions());

  async acquire(key: string, ttlMs: number): Promise<string | undefined> {
    const token = randomUUID();
    const ok = await this.redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : undefined;
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      `lock:${key}`,
      token,
    );
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }
}
