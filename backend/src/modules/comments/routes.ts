import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { optionalAuth, requireActiveWriter, requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { rateLimit } from "../../middleware/rateLimit";
import { uuidParamSchema } from "../spots/schemas";
import { createReport } from "../reports/service";
import { bigintParam } from "../../utils/params";
import {
  approveComment,
  createComment,
  deleteComment,
  hideComment,
  listComments,
  listPendingComments,
  updateComment,
} from "./service";

export const commentsRouter = Router();
export const moderationCommentsRouter = Router();

const pagedQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const commentIdParam = z.object({ id: z.coerce.bigint() });

commentsRouter.get(
  "/spots/:uuid/comments",
  optionalAuth,
  validate({ params: uuidParamSchema, query: pagedQuery }),
  asyncHandler(async (req, res) => {
    const result = await listComments(req.params.uuid, req.query as never, req.user);
    res.json(ok(req, result));
  }),
);

commentsRouter.post(
  "/spots/:uuid/comments",
  requireAuth,
  requireActiveWriter,
  rateLimit({ scope: "comment-create", limit: 30, windowSeconds: 3600 }),
  validate({
    params: uuidParamSchema,
    body: z.object({
      body: z.string().trim().min(1, "评论不能为空").max(300, "评论不超过 300 字"),
      parentId: z.union([z.coerce.bigint(), z.null()]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const comment = await createComment(req.params.uuid, req.user!, {
      body: req.body.body,
      parentId: req.body.parentId ?? undefined,
    });
    res.status(201).json(ok(req, comment));
  }),
);

commentsRouter.patch(
  "/comments/:id",
  requireAuth,
  requireActiveWriter,
  validate({
    params: commentIdParam,
    body: z.object({ body: z.string().trim().min(1).max(300) }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await updateComment(bigintParam(req, "id"), req.user!, req.body.body)));
  }),
);

commentsRouter.delete(
  "/comments/:id",
  requireAuth,
  validate({ params: commentIdParam }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await deleteComment(bigintParam(req, "id"), req.user!)));
  }),
);

// 举报评论：复用统一的举报入口，保证举报逻辑只有一份
commentsRouter.post(
  "/comments/:id/report",
  requireAuth,
  rateLimit({ scope: "report", limit: 30, windowSeconds: 86400 }),
  validate({
    params: commentIdParam,
    body: z.object({
      reason: z.string().min(1).max(32),
      detail: z.string().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const report = await createReport(req.user!, {
      targetType: "comment",
      targetId: bigintParam(req, "id"),
      reason: req.body.reason,
      detail: req.body.detail,
    });
    res.status(201).json(ok(req, report));
  }),
);

moderationCommentsRouter.get(
  "/moderation/comments",
  requireAuth,
  requireRole("moderator"),
  validate({ query: pagedQuery }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await listPendingComments(req.query as never)));
  }),
);

moderationCommentsRouter.post(
  "/moderation/comments/:id/approve",
  requireAuth,
  requireRole("moderator"),
  validate({ params: commentIdParam }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await approveComment(bigintParam(req, "id"), req.user!)));
  }),
);

moderationCommentsRouter.post(
  "/moderation/comments/:id/hide",
  requireAuth,
  requireRole("moderator"),
  validate({
    params: commentIdParam,
    body: z.object({ reason: z.string().trim().min(2, "请填写隐藏理由").max(200) }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await hideComment(bigintParam(req, "id"), req.user!, req.body.reason)));
  }),
);
