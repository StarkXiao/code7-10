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
  // 新建草稿时若来自离线本地草稿，可带上逐字段修改时间
  fieldTimestamps: z.record(z.string().datetime({ message: "字段时间必须是 ISO 8601 时间" })).optional(),
});

export const updateSpotSchema = createSpotSchema.partial().extend({
  // 离线补传时携带的基线版本（GET / PATCH 返回的 updatedAt）。
  // 落后于服务端当前版本时不做覆盖，返回 409 让客户端走"按时间戳合并 + 用户确认"。
  baseUpdatedAt: z.string().datetime({ message: "baseUpdatedAt 必须是 ISO 8601 时间" }).optional(),
  // 客户端记录的逐字段最后修改时间（ISO 8601），属性字段形如 attributes.has_backrest
  fieldTimestamps: z.record(z.string().datetime({ message: "字段时间必须是 ISO 8601 时间" })).optional(),
});

/**
 * 用户在合并对话框里确认后的最终内容。
 * fields 是展平字段：标量字段直接给（title / lat / mediaUuids …），
 * 属性字段用 attributes.<key> 形式逐 key 给，只更新确认过的属性，
 * 不会把同分类下的其他属性冲掉。
 */
export const mergeSpotSchema = z.object({
  fields: z
    .object({
      categoryCode: z.string().trim().min(1).max(32),
      title: z.string().trim().min(2).max(40),
      description: z.string().trim().max(500).or(z.literal("")),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      fuzzEnabled: z.boolean(),
      fuzzRadiusM: z.number().int().min(0).max(500),
      mediaUuids: z.array(z.string().uuid("图片标识不正确")).max(6),
    })
    .partial()
    .catchall(z.unknown()),
  baseUpdatedAt: z.string().datetime({ message: "baseUpdatedAt 必须是 ISO 8601 时间" }),
  fieldTimestamps: z.record(z.string().datetime({ message: "字段时间必须是 ISO 8601 时间" })).default({}),
});

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

export type CreateSpotInput = z.infer<typeof createSpotSchema>;
export type UpdateSpotInput = z.infer<typeof updateSpotSchema>;
export type MergeSpotInput = z.infer<typeof mergeSpotSchema>;
export type ListSpotsQuery = z.infer<typeof listSpotsQuerySchema>;
export type ConfirmInput = z.infer<typeof confirmSchema>;
