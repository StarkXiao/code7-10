import IORedis from "ioredis";
import { WORKER_HEARTBEAT_KEY } from "../config/constants";

// worker 不监听任何端口，无法用 HTTP 探活。
// 它每 20 秒往 Redis 写一次带 TTL 的心跳，这里检查心跳是否还新鲜。
async function main(): Promise<void> {
  const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
  });

  try {
    const value = await redis.get(WORKER_HEARTBEAT_KEY);
    if (!value) {
      console.error("worker 心跳缺失，可能已经停止工作");
      process.exit(1);
    }

    const ageSeconds = (Date.now() - Number(value)) / 1000;
    if (!Number.isFinite(ageSeconds) || ageSeconds > 60) {
      console.error(`worker 心跳已过期（${ageSeconds.toFixed(0)} 秒前）`);
      process.exit(1);
    }

    console.log(`worker 心跳正常（${ageSeconds.toFixed(0)} 秒前）`);
    process.exit(0);
  } catch (error) {
    console.error(`心跳检查失败：${(error as Error).message}`);
    process.exit(1);
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

void main();
