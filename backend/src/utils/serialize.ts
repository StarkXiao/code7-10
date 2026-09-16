import type { Request } from "express";

/** traceId 由 requestId 中间件注入，用于把响应与日志串起来 */
export function getTraceId(req: Request): string {
  return (req as Request & { traceId?: string }).traceId ?? "unknown";
}

export function ok<T>(req: Request, data: T) {
  return { success: true as const, data, traceId: getTraceId(req) };
}

export function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return (raw ?? req.socket.remoteAddress)?.trim() || undefined;
}

export function userAgent(req: Request): string | undefined {
  return req.headers["user-agent"]?.slice(0, 300);
}
