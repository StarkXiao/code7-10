import IORedis, { type Redis } from "ioredis";
import { env } from "../config/env";
import { logger } from "../utils/logger";

function createClient(label: string, options: Record<string, unknown> = {}): Redis {
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...options,
  });

  // 不监听 error 会让 ioredis 的未处理事件直接终止进程
  client.on("error", (error: Error) => {
    logger.warn({ err: error.message, client: label }, "Redis 连接异常");
  });

  return client;
}

export const redis = createClient("general");

/** BullMQ 要求独立连接且 maxRetriesPerRequest 为 null */
export function createBullConnection(): Redis {
  return createClient("bull");
}

export async function closeRedis(): Promise<void> {
  await redis.quit().catch(() => undefined);
}

export async function pingRedis(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}
