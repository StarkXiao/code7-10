import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { AUDIT_ACTIONS } from "../../config/constants";
import { recordAudit } from "../../services/audit";
import { bigintParam } from "../../utils/params";
import { createCategory, listCategories, publishSchema, updateCategory } from "./service";

export const categoriesRouter = Router();
export const adminCategoriesRouter = Router();

const schemaBody = z.object({
  type: z.literal("object"),
  required: z.array(z.string()).optional(),
  properties: z.record(
    z.object({
      type: z.enum(["boolean", "integer", "number", "string", "array"]),
      label: z.string().max(40).optional(),
      help: z.string().max(120).optional(),
      ui: z.string().max(24).optional(),
      unit: z.string().max(16).optional(),
      enum: z.array(z.string()).optional(),
      enumLabels: z.record(z.string()).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      maxLength: z.number().int().positive().optional(),
      items: z
        .object({ type: z.string(), enum: z.array(z.string()).optional() })
        .optional(),
    }),
  ),
});

// 前端据此渲染动态属性表单，因此必须包含当前 Schema 版本
categoriesRouter.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const categories = await listCategories();
    res.json(
      ok(req, {
        items: categories.map((category) => ({
          code: category.code,
          name: category.name,
          icon: category.icon,
          color: category.color,
          description: category.description,
          sortOrder: category.sortOrder,
          schemaVersion: category.schemaVersion,
          schema: category.schema,
        })),
      }),
    );
  }),
);

adminCategoriesRouter.get(
  "/admin/categories",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const categories = await listCategories({ includeInactive: true });
    res.json(
      ok(req, {
        items: categories.map((category) => ({
          id: category.id,
          code: category.code,
          name: category.name,
          icon: category.icon,
          color: category.color,
          description: category.description,
          sortOrder: category.sortOrder,
          isActive: category.isActive,
          schemaVersion: category.schemaVersion,
          schema: category.schema,
        })),
      }),
    );
  }),
);

adminCategoriesRouter.post(
  "/admin/categories",
  requireAuth,
  requireRole("admin"),
  validate({
    body: z.object({
      code: z
        .string()
        .regex(/^[a-z][a-z0-9_]{1,31}$/, "分类代码只能是小写字母、数字与下划线"),
      name: z.string().trim().min(1).max(16),
      icon: z.string().max(64),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "颜色需为 #RRGGBB 格式"),
      description: z.string().max(200).optional(),
      sortOrder: z.number().int().min(0).max(999).optional(),
      schema: schemaBody,
    }),
  }),
  asyncHandler(async (req, res) => {
    const category = await createCategory({ ...req.body, actorId: req.user!.id });
    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.CATEGORY_SCHEMA_UPDATE,
      targetType: "category",
      targetId: category.id,
      after: { code: category.code, version: 1 },
      req,
    });
    res.status(201).json(ok(req, { category }));
  }),
);

adminCategoriesRouter.patch(
  "/admin/categories/:id",
  requireAuth,
  requireRole("admin"),
  validate({
    params: z.object({ id: z.coerce.bigint() }),
    body: z.object({
      name: z.string().trim().min(1).max(16).optional(),
      icon: z.string().max(64).optional(),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      description: z.string().max(200).optional(),
      sortOrder: z.number().int().min(0).max(999).optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const category = await updateCategory(bigintParam(req, "id"), req.body);
    res.json(ok(req, { category }));
  }),
);

// 发布新版本 Schema：旧版本保留，已有条目不受影响，新提交按新版本校验
adminCategoriesRouter.put(
  "/admin/categories/:id/schema",
  requireAuth,
  requireRole("admin"),
  validate({
    params: z.object({ id: z.coerce.bigint() }),
    body: z.object({ schema: schemaBody }),
  }),
  asyncHandler(async (req, res) => {
    const result = await publishSchema(bigintParam(req, "id"), req.body.schema, req.user!.id);

    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.CATEGORY_SCHEMA_UPDATE,
      targetType: "category",
      targetId: bigintParam(req, "id"),
      before: result.previous ? { schema: result.previous } : undefined,
      after: { version: result.version, schema: req.body.schema },
      req,
    });

    res.json(ok(req, result));
  }),
);
