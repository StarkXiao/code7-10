import { Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { prisma } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { logger } from "../../utils/logger";

export const usersRouter = Router();

usersRouter.get(
  "/me/settings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const settings = await prisma.userSetting.findUnique({ where: { userId: req.user!.id } });
    res.json(
      ok(req, {
        settings: settings ?? {
          defaultFuzzRadius: 50,
          notifyEmail: true,
          notifyInapp: true,
          locale: "zh-CN",
        },
      }),
    );
  }),
);

usersRouter.patch(
  "/me/settings",
  requireAuth,
  validate({
    body: z.object({
      defaultFuzzRadius: z.number().int().min(0).max(500).optional(),
      notifyEmail: z.boolean().optional(),
      notifyInapp: z.boolean().optional(),
      locale: z.enum(["zh-CN", "en-US"]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const settings = await prisma.userSetting.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, ...req.body },
      update: req.body,
    });
    res.json(ok(req, { settings }));
  }),
);

/**
 * 注销账号。
 * 按文档 6.5：个人身份信息匿名化，历史贡献保留但不再关联到具体个人。
 * 这样既不破坏地图完整性，也不给用户留下"删不干净"的担忧。
 */
usersRouter.post(
  "/me/delete-account",
  requireAuth,
  validate({ body: z.object({ confirm: z.literal("DELETE") }) }),
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;

    const ownedSpots = await prisma.spot.count({ where: { ownerId: userId, deletedAt: null } });

    await prisma.$transaction([
      prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "account_deleted" },
      }),
      prisma.user.update({
        where: { id: userId },
        data: {
          email: null,
          phone: null,
          nickname: "已注销用户",
          avatarUrl: null,
          passwordHash: crypto.randomBytes(48).toString("hex"),
          status: "deleted",
          deletedAt: new Date(),
        },
      }),
      prisma.userSetting.deleteMany({ where: { userId } }),
      prisma.favorite.deleteMany({ where: { userId } }),
      prisma.notification.deleteMany({ where: { userId } }),
    ]);

    logger.info({ userId: userId.toString(), ownedSpots }, "用户注销并完成匿名化");

    res.clearCookie("psdm_rt", { path: "/" });
    res.json(
      ok(req, {
        deleted: true,
        message:
          ownedSpots > 0
            ? `账号已注销，你的 ${ownedSpots} 条记录已转为匿名保留在地图上。`
            : "账号已注销。",
      }),
    );
  }),
);
