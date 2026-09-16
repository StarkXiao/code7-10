import type { Request } from "express";
import { prisma, toJsonValue } from "../db/prisma";
import { logger } from "../utils/logger";
import { clientIp, userAgent } from "../utils/serialize";
import type { AuditAction } from "../config/constants";

export interface AuditInput {
  actorId?: bigint | null;
  action: AuditAction;
  targetType?: string;
  targetId?: bigint | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
  req?: Request;
}

/**
 * 审计日志是合规要求的一部分：审核决策、隐私操作、封禁都必须留痕。
 * 写入失败只告警不抛出，避免影响主流程，但会被日志系统捕获。
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        before: input.before === undefined ? undefined : toJsonValue(input.before),
        after: input.after === undefined ? undefined : toJsonValue(input.after),
        reason: input.reason ?? null,
        ip: input.req ? (clientIp(input.req) ?? null) : null,
        userAgent: input.req ? (userAgent(input.req) ?? null) : null,
        traceId: input.req?.traceId ?? null,
      },
    });
  } catch (error) {
    logger.error({ err: (error as Error).message, action: input.action }, "审计日志写入失败");
  }
}
