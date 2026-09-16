import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { MulterError } from "multer";
import { ERROR_CODES } from "../config/constants";
import { AppError } from "../utils/errors";
import { logger } from "../utils/logger";
import { getTraceId } from "../utils/serialize";
import { isProd } from "../config/env";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: ERROR_CODES.NOT_FOUND, message: `接口不存在：${req.method} ${req.path}` },
    traceId: getTraceId(req),
  });
}

function normalize(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return new AppError(413, ERROR_CODES.FILE_TOO_LARGE, "图片体积超过限制");
    }
    return AppError.badRequest(`上传失败：${error.message}`);
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return AppError.conflict(ERROR_CODES.VALIDATION_FAILED, "该记录已存在，请勿重复提交");
    }
    if (error.code === "P2025") {
      return AppError.notFound();
    }
    if (error.code === "P2003") {
      return AppError.badRequest("关联数据不存在");
    }
  }

  return new AppError(500, ERROR_CODES.INTERNAL_ERROR, "服务器内部错误");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appError = normalize(error);

  if (appError.status >= 500) {
    logger.error(
      { err: error instanceof Error ? error.stack : error, traceId: getTraceId(req), path: req.path },
      "未处理的服务端异常",
    );
  } else {
    logger.debug({ code: appError.code, path: req.path, traceId: getTraceId(req) }, "请求被拒绝");
  }

  const payload: Record<string, unknown> = {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
    },
    traceId: getTraceId(req),
  };

  if (appError.details) {
    (payload.error as Record<string, unknown>).details = appError.details;
  }

  // 生产环境不回传堆栈，避免泄露内部结构
  if (!isProd && appError.status >= 500 && error instanceof Error) {
    (payload.error as Record<string, unknown>).stack = error.stack;
  }

  res.status(appError.status).json(payload);
}
