/**
 * 多端离线合并（前端版）。
 *
 * 与后端 src/modules/spots/merge.ts 保持同一套语义：
 * 三方（共同基线 / 服务端 / 本地）逐字段比较，只有真正分叉的字段进冲突对话框；
 * 默认值按字段时间戳取较新一方，但最终入库内容必须由用户确认。
 */
import type { MergeConflictField, SpotDraftPayload } from "@/api/types";

export const SCALAR_FIELDS = [
  "categoryCode",
  "title",
  "description",
  "lat",
  "lng",
  "fuzzEnabled",
  "fuzzRadiusM",
  "mediaUuids",
] as const;

export type FieldMap = Record<string, unknown>;
export type TimestampMap = Record<string, string>;

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => valuesEqual(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => valuesEqual(left[key], right[key]));
  }
  return false;
}

export function flattenSpotFields(input: Partial<SpotDraftPayload>): FieldMap {
  const out: FieldMap = {};
  for (const field of SCALAR_FIELDS) {
    const value = input[field];
    if (value !== undefined) out[field] = value;
  }
  for (const [key, value] of Object.entries(input.attributes ?? {})) {
    out[`attributes.${key}`] = value;
  }
  return out;
}

/** 展平字段还原成草稿载荷；空的 attributes 仍保留为 {}，方便表单绑定 */
export function unflattenSpotFields(fields: FieldMap): Partial<SpotDraftPayload> {
  const out: Partial<SpotDraftPayload> = { attributes: {} };
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("attributes.")) {
      out.attributes![key.slice("attributes.".length)] = value;
    } else {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function isAfter(a?: string | null, b?: string | null): boolean {
  return Boolean(a && (!b || new Date(a).getTime() > new Date(b).getTime()));
}

export interface MergeResult {
  merged: FieldMap;
  conflicts: MergeConflictField[];
}

export function buildMergeProposal(input: {
  base: FieldMap;
  server: FieldMap;
  client: FieldMap;
  serverTimestamps: TimestampMap;
  clientTimestamps: TimestampMap;
}): MergeResult {
  const merged: FieldMap = {};
  const conflicts: MergeConflictField[] = [];

  const fields = new Set([...Object.keys(input.server), ...Object.keys(input.client), ...Object.keys(input.base)]);

  for (const field of fields) {
    const baseValue = input.base[field];
    const serverValue = input.server[field];
    const clientValue = input.client[field];

    const serverChanged = !valuesEqual(serverValue, baseValue);
    const clientChanged = !valuesEqual(clientValue, baseValue);

    if (!serverChanged) {
      merged[field] = clientValue;
      continue;
    }
    if (!clientChanged) {
      merged[field] = serverValue;
      continue;
    }
    if (valuesEqual(serverValue, clientValue)) {
      merged[field] = serverValue;
      continue;
    }

    const serverTs = input.serverTimestamps[field] ?? null;
    const clientTs = input.clientTimestamps[field] ?? null;
    const winner = isAfter(clientTs, serverTs) ? "client" : "server";

    merged[field] = winner === "client" ? clientValue : serverValue;
    conflicts.push({
      field,
      base: baseValue,
      server: serverValue,
      client: clientValue,
      serverUpdatedAt: serverTs,
      clientUpdatedAt: clientTs,
      winner,
    });
  }

  return { merged, conflicts };
}

/** 字段中文标签（属性字段用 key 本身，合并对话框里再结合 Schema 翻译） */
export function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    categoryCode: "分类",
    title: "标题",
    description: "描述",
    lat: "纬度",
    lng: "经度",
    fuzzEnabled: "位置模糊开关",
    fuzzRadiusM: "模糊半径",
    mediaUuids: "照片",
  };
  if (labels[field]) return labels[field]!;
  if (field.startsWith("attributes.")) return field.slice("attributes.".length);
  return field;
}

/** 把字段值格式化成对话框里能看懂的短文本 */
export function formatFieldValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "（空）";
  if (field === "fuzzEnabled") return value ? "开启" : "关闭";
  if (field === "mediaUuids") return Array.isArray(value) ? `${value.length} 张照片` : String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map((item) => String(item)).join("、");
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
