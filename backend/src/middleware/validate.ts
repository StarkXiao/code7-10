import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodTypeAny } from "zod";
import { AppError } from "../utils/errors";

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function toAppError(error: ZodError): AppError {
  const details = error.issues.map((issue) => ({
    field: issue.path.join("."),
    rule: issue.code,
    message: issue.message,
  }));
  const first = details[0];
  return AppError.badRequest(
    first ? `${first.field || "参数"}：${first.message}` : "请求参数校验失败",
    details,
  );
}

/** 校验并覆盖请求中的 body/query/params，业务代码拿到的永远是校验后的值 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) req.query = schemas.query.parse(req.query) as Request["query"];
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) return next(toAppError(error));
      next(error);
    }
  };
}
