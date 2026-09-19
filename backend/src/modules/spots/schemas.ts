import { z } from "zod";

const boolQuery = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .optional()
  .transform((value) => (typeof value === "boolean" ? value : value === "true"));

const multi = z.union([z.string(), z.array(z.string())]).optional();

export const createSpotSchema = z.object({
  categoryCode: z.string().trim().min(1, "请选择分类").max(32),
  title: z.string().trim().min(2, "标题至少 2 个字").max(40, "标题不超过 40 个字"),
  description: z.string().trim().max(500, "描述不超过 500 字").optional().or(z.literal("")),
  attributes: z.record(z.unknown()).default({}),
  lat: z.number().min(-90, "纬度超出范围").max(90, "纬度超出范围"),
  lng: z.number().min(-180, "经度超出范围").max(180, "经度超出范围"),
  fuzzEnabled: z.boolean().default(true),
  fuzzRadiusM: z.number().int().min(0).max(500).default(50),
  mediaUuids: z.array(z.string().uuid("图片标识不正确")).max(6, "最多 6 张图片").default([]),
  // 移动端离线补传的幂等键：同一键的重复请求直接返回首次创建的草稿，
  // 避免弱网重试导致同一条记录落库两次。
  clientKey: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/, "客户端标识格式不正确").optional(),
});

// 乐观锁：PATCH 带上次读到的 updatedAt（ISO 时间）。
// 编辑期间条目被其他设备改过则返回 409，由前端按字段时间戳合并后让用户确认。
const baseUpdatedAtSchema = z
  .string()
  .datetime({ offset: true, message: "版本时间格式不正确" })
  .optional();

export const updateSpotSchema = createSpotSchema
  .partial()
  .extend({ baseUpdatedAt: baseUpdatedAtSchema });

export type CreateSpotInput = z.infer<typeof createSpotSchema>;
export type UpdateSpotInput = z.infer<typeof updateSpotSchema>;

export const listSpotsQuerySchema = z.object({
  bbox: z.string().optional(),
  near: z.string().optional(),
  radius: z.coerce.number().int().min(50).max(20000).optional(),
  category: multi,
  attr: multi,
  q: z.string().trim().max(60).optional(),
  fresh: boolQuery,
  sort: z.enum(["freshness", "distance", "newest"]).default("freshness"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const confirmSchema = z.object({
  isAccurate: z.boolean(),
  note: z.string().trim().max(200).optional(),
});

export const mySpotsQuerySchema = z.object({
  status: z
    .enum([
      "draft",
      "pending",
      "in_review",
      "auto_rejected",
      "changes_requested",
      "published",
      "rejected",
      "appealing",
      "rejected_final",
      "hidden",
      "archived",
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const appealSchema = z.object({
  reason: z.string().trim().min(10, "请说明申诉理由，至少 10 个字").max(500),
});

export const uuidParamSchema = z.object({
  uuid: z.string().uuid("条目标识不正确"),
});

export type ListSpotsQuery = z.infer<typeof listSpotsQuerySchema>;
export type ConfirmInput = z.infer<typeof confirmSchema>;
