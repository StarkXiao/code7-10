import type { NextFunction, Request, RequestHandler, Response } from "express";

/** 包装 async 路由，自动把 rejected promise 交给错误中间件 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
