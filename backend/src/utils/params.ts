import type { Request } from "express";
import { AppError } from "./errors";

// Express 把 req.params 一律视为字符串，而我们的主键是 BigInt。
// validate 中间件已经用 zod 做过校验，这里再做一次显式转换，
// 避免在几十个调用点各写一遍 as unknown as bigint。
export function bigintParam(req: Request, name: string): bigint {
  const raw = (req.params as Record<string, unknown>)[name];

  if (typeof raw === "bigint") return raw;

  const value = String(raw ?? "").trim();
  if (!/^\d+$/.test(value)) {
    throw AppError.badRequest(`参数 ${name} 必须是正整数`);
  }

  return BigInt(value);
}
