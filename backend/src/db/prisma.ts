import { Prisma, PrismaClient } from "@prisma/client";
import { env, isTest } from "../config/env";

// BigInt 无法被 JSON.stringify 处理，统一序列化为字符串，
// 前端以字符串形态传递 id，服务端用 zod 转回 BigInt。
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON() {
  return this.toString();
};

const globalForPrisma = globalThis as unknown as { __psdmPrisma?: PrismaClient };

export const prisma =
  globalForPrisma.__psdmPrisma ??
  new PrismaClient({
    log:
      env.NODE_ENV === "development"
        ? [{ emit: "event", level: "warn" }, { emit: "event", level: "error" }]
        : [{ emit: "event", level: "error" }],
  });

if (!isTest) {
  globalForPrisma.__psdmPrisma = prisma;
}

export { Prisma };
export type { PrismaClient };

/** JSON 字段在 Prisma 中读写需要显式类型，集中封装避免各处强转 */
export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
