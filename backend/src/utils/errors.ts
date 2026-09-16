import { ERROR_CODES, type ErrorCode } from "../config/constants";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, ERROR_CODES.VALIDATION_FAILED, message, details);
  }

  static unauthorized(message = "请先登录", code: ErrorCode = ERROR_CODES.AUTH_REQUIRED) {
    return new AppError(401, code, message);
  }

  static forbidden(message = "没有权限执行该操作") {
    return new AppError(403, ERROR_CODES.FORBIDDEN, message);
  }

  static notFound(message = "资源不存在") {
    return new AppError(404, ERROR_CODES.NOT_FOUND, message);
  }

  static conflict(code: ErrorCode, message: string) {
    return new AppError(409, code, message);
  }

  static unprocessable(code: ErrorCode, message: string, details?: unknown) {
    return new AppError(422, code, message, details);
  }
}
