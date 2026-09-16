import { afterAll, beforeAll } from "vitest";
import IORedis from "ioredis";

// 限流计数存在 Redis 里，会跨测试文件、跨运行累积。
// 不清掉的话，同一套集成测试在 10 分钟内跑第二次就会撞上 429，
// 变成"要么等十分钟，要么误以为代码坏了"。
let redis: IORedis | undefined;

beforeAll(async () => {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";

  try {
    redis = new IORedis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    const keys = await redis.keys("ratelimit:*");
    if (keys.length > 0) await redis.del(...keys);

    const captchaKeys = await redis.keys("captcha:*");
    if (captchaKeys.length > 0) await redis.del(...captchaKeys);
  } catch {
    // Redis 不可用时集成测试本来就会失败，这里不额外抛错掩盖真正的原因
  }
});

afterAll(async () => {
  await redis?.quit().catch(() => undefined);
});
