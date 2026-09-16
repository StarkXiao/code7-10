import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * 为每个请求分配 traceId，贯穿日志与错误响应。
 * 上游若已带 X-Request-Id（网关/负载均衡），复用它以便全链路追踪。
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers["x-request-id"];
  const traceId =
    (Array.isArray(incoming) ? incoming[0] : incoming)?.slice(0, 64) ??
    crypto.randomUUID().replace(/-/g, "");

  req.traceId = traceId;
  res.setHeader("X-Request-Id", traceId);
  next();
}
