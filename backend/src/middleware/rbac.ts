import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { UserRole } from "@prisma/client";
import { AppError } from "../utils/errors";
import { hasRole, ROLE_RANK } from "../types/auth";

/** 要求至少具备某个角色（角色是包含关系：admin > moderator > user > visitor） */
export function requireRole(minRole: UserRole): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(AppError.unauthorized("请先登录"));
    if (!hasRole(req.user, minRole)) {
      return next(
        AppError.forbidden(
          `该操作需要 ${ROLE_RANK[minRole] >= ROLE_RANK.admin ? "管理员" : "审核员"} 权限`,
        ),
      );
    }
    next();
  };
}

/**
 * 资源归属校验：作者本人或审核员以上可通过。
 * 用于"只能修改自己提交的条目"这类规则。
 */
export function requireSelfOrModerator(
  resolveOwnerId: (req: Request) => Promise<bigint | undefined>,
): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) return next(AppError.unauthorized("请先登录"));
      if (hasRole(req.user, "moderator")) return next();

      const ownerId = await resolveOwnerId(req);
      if (ownerId === undefined) return next(AppError.notFound());
      if (ownerId !== req.user.id) return next(AppError.forbidden("你只能操作自己提交的内容"));

      next();
    } catch (error) {
      next(error);
    }
  };
}

export { hasRole };
