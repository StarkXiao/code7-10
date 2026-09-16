import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ERROR_CODES } from "../config/constants";
import { redis } from "../db/redis";
import { AppError } from "../utils/errors";
import { logger } from "../utils/logger";

export interface RateLimitOptions {
  /** 窗口内允许的最大请求数 */
  limit: number;
  /** 窗口长度（秒） */
  windowSeconds: number;
  /** 限流维度，默认按 IP */
  keyGenerator?: (req: Request) => string;
  /** 前缀，便于区分不同限流策略 */
  scope: string;
}

/**
 * 基于 Redis 的固定窗口限流。
 * Redis 不可用时**放行**并记录告警——限流是保护手段，
 * 不应因为缓存故障把整个服务变成不可用。
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const identity =
      options.keyGenerator?.(req) ??
      (req.user ? `u:${req.user.uuid}` : `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`);
    const window = Math.floor(Date.now() / (options.windowSeconds * 1000));
    const key = `ratelimit:${options.scope}:${identity}:${window}`;

    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, options.windowSeconds);
      }

      const remaining = Math.max(0, options.limit - count);
      res.setHeader("X-RateLimit-Limit", options.limit);
      res.setHeader("X-RateLimit-Remaining", remaining);

      if (count > options.limit) {
        const ttl = await redis.ttl(key);
        res.setHeader("Retry-After", Math.max(1, ttl));
        throw new AppError(
          429,
          ERROR_CODES.RATE_LIMITED,
          `操作过于频繁，请 ${Math.max(1, ttl)} 秒后再试`,
        );
      }
      next();
    } catch (error) {
      if (error instanceof AppError) return next(error);
      logger.warn({ err: (error as Error).message, scope: options.scope }, "限流组件异常，已放行");
      next();
    }
  };
}
