import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { rateLimit } from "../../middleware/rateLimit";
import { REPORT_REASONS, REPORT_TARGET_TYPES } from "../../config/constants";
import { bigintParam } from "../../utils/params";
import { createReport, dismissReport, getReportDetail, listReports, resolveReport } from "./service";

export const reportsRouter = Router();
export const moderationReportsRouter = Router();

const reasonEnum = z.enum(Object.keys(REPORT_REASONS) as [string, ...string[]]);
const targetTypeEnum = z.enum(REPORT_TARGET_TYPES as unknown as [string, ...string[]]);

reportsRouter.post(
  "/reports",
  requireAuth,
  rateLimit({ scope: "report", limit: 30, windowSeconds: 86400 }),
  validate({
    body: z.object({
      targetType: targetTypeEnum,
      targetId: z.coerce.bigint(),
      reason: reasonEnum,
      detail: z.string().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const report = await createReport(req.user!, req.body);
    res.status(201).json(ok(req, report));
  }),
);

reportsRouter.get(
  "/reports/reasons",
  asyncHandler(async (req, res) => {
    res.json(
      ok(req, {
        reasons: Object.entries(REPORT_REASONS).map(([code, label]) => ({ code, label })),
        targetTypes: REPORT_TARGET_TYPES,
      }),
    );
  }),
);

moderationReportsRouter.get(
  "/moderation/reports",
  requireAuth,
  requireRole("moderator"),
  validate({
    query: z.object({
      status: z.enum(["open", "in_review", "resolved", "dismissed"]).optional(),
      targetType: targetTypeEnum.optional(),
      overdueOnly: z.coerce.boolean().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await listReports(req.query as never)));
  }),
);

moderationReportsRouter.get(
  "/moderation/reports/:id",
  requireAuth,
  requireRole("moderator"),
  validate({ params: z.object({ id: z.coerce.bigint() }) }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await getReportDetail(bigintParam(req, "id"))));
  }),
);

moderationReportsRouter.post(
  "/moderation/reports/:id/resolve",
  requireAuth,
  requireRole("moderator"),
  validate({
    params: z.object({ id: z.coerce.bigint() }),
    body: z.object({ note: z.string().trim().min(2, "请填写处理说明").max(300) }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await resolveReport(bigintParam(req, "id"), req.user!, req.body.note)));
  }),
);

moderationReportsRouter.post(
  "/moderation/reports/:id/dismiss",
  requireAuth,
  requireRole("moderator"),
  validate({
    params: z.object({ id: z.coerce.bigint() }),
    body: z.object({ note: z.string().trim().min(2, "请填写判定说明").max(300) }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await dismissReport(bigintParam(req, "id"), req.user!, req.body.note)));
  }),
);
