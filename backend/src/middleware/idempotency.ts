import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma";
import { AppError } from "../utils/errors";
import { sha256 } from "../utils/crypto";
import { ERROR_CODES } from "../config/constants";
import { logger } from "../utils/logger";

/**
 * 幂等中间件（《项目文档.md》10.1 节：写操作支持 Idempotency-Key 头）。
 *
 * 移动端在弱网/断网下补传时无法确认上一次请求是否到达服务端，
 * 没有幂等保护，重试 POST /spots 就会产生重复草稿。
 *
 * 约定：
 * - 客户端在请求头带 `Idempotency-Key`（≤ 64 字符）；
 * - 同用户同键 24 小时内的重试直接返回首次的状态码与响应体；
 * - 同键但请求体不同（路径/方法/Body 哈希不一致）返回 422，
 *   防止业务代码误用同一个键掩盖了发错请求的 bug。
 */
const TTL_MS = 24 * 60 * 60 * 1000;

export function idempotent() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header("Idempotency-Key");
    if (!key || !req.user) {
      next();
      return;
    }
    if (key.length > 64) {
      throw AppError.badRequest("Idempotency-Key 长度不能超过 64");
    }

    const requestHash = sha256(`${req.method} ${req.path}\n${JSON.stringify(req.body ?? {})}`);

    const existing = await prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId: req.user.id, key } },
    });

    if (existing) {
      if (existing.expiresAt < new Date()) {
        await prisma.idempotencyKey.delete({ where: { id: existing.id } }).catch(() => undefined);
      } else if (existing.requestHash !== requestHash) {
        throw new AppError(
          422,
          ERROR_CODES.IDEMPOTENCY_REPLAY_MISMATCH,
          "同一个幂等键对应的请求内容不一致，请使用新的键重试",
        );
      } else {
        res.status(existing.statusCode).json(existing.response);
        return;
      }
    }

    // 拦截真正的响应（只缓存成功的业务结果；4xx/5xx 允许客户端修正后用同键重试）
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const statusCode = res.statusCode;
      if (statusCode >= 200 && statusCode < 300) {
        // 并发重试可能同时走到这里：唯一键已存在时保留首次响应，不覆盖
        prisma.idempotencyKey
          .upsert({
            where: { userId_key: { userId: req.user!.id, key } },
            update: {},
            create: {
              userId: req.user!.id,
              key,
              method: req.method,
              path: req.path,
              requestHash,
              statusCode,
              response: body as object,
              expiresAt: new Date(Date.now() + TTL_MS),
            },
          })
          .catch((error) => logger.debug({ err: error }, "幂等记录落库失败，可能为并发重试"));
      }
      return originalJson(body as object);
    };

    next();
  };
}
