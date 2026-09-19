/**
 * 多端离线编辑的字段级时间戳合并。
 *
 * 策略：不做"整条后写覆盖"。每个字段（含 attributes 下的每个属性）
 * 各自记录最后修改时间，补传时逐字段比较；三方（共同基线 / 服务端 / 本地）
 * 都参与判断，只有真正分叉的字段才标记为冲突，交用户在合并对话框里确认。
 *
 * 纯函数，不依赖数据库，前后端共用同一份语义（前端另有镜像实现）。
 */

export const SPOT_SCALAR_FIELDS = [
  "categoryCode",
  "title",
  "description",
  "lat",
  "lng",
  "fuzzEnabled",
  "fuzzRadiusM",
  "mediaUuids",
] as const;

export type SpotScalarField = (typeof SPOT_SCALAR_FIELDS)[number];

/** 展平后的字段值：标量字段直接取值，属性字段键形如 attributes.has_backrest */
export type FieldMap = Record<string, unknown>;
export type TimestampMap = Record<string, string>;

export interface SpotFieldInput {
  categoryCode?: string;
  title?: string;
  description?: string | null;
  attributes?: Record<string, unknown> | null;
  lat?: number;
  lng?: number;
  fuzzEnabled?: boolean;
  fuzzRadiusM?: number;
  mediaUuids?: string[];
}

function valuesEqual(a: unknown, b: unknown): boolean {
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

/** 把条目内容展平成 field -> value */
export function flattenSpotFields(input: SpotFieldInput): FieldMap {
  const out: FieldMap = {};
  for (const field of SPOT_SCALAR_FIELDS) {
    const value = input[field];
    if (value !== undefined) out[field] = value;
  }
  for (const [key, value] of Object.entries(input.attributes ?? {})) {
    out[`attributes.${key}`] = value;
  }
  return out;
}

/** 展平字段还原成接口载荷（只包含给定字段） */
export function unflattenSpotFields(fields: FieldMap): SpotFieldInput {
  const out: SpotFieldInput = { attributes: {} };
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("attributes.")) {
      out.attributes![key.slice("attributes.".length)] = value;
    } else {
      out[key as SpotScalarField] = value as never;
    }
  }
  return out;
}

function isAfter(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && (!b || new Date(a).getTime() > new Date(b).getTime()));
}

export interface MergeConflict {
  field: string;
  base: unknown;
  server: unknown;
  client: unknown;
  serverUpdatedAt: string | null;
  clientUpdatedAt: string | null;
  /** 按时间戳自动取的较新一方，作为对话框里的默认选中项 */
  winner: "server" | "client";
}

export interface MergeProposal {
  /** 按时间戳合并后的建议字段 */
  merged: FieldMap;
  /** 真正分叉、需要用户确认的字段 */
  conflicts: MergeConflict[];
}

/**
 * 三方合并：
 * - 任一方相对共同基线未改动 → 取另一方；
 * - 两边都改但结果相同 → 直接采用；
 * - 两边都改且不同 → 冲突，按时间戳预选较新一方，等用户拍板。
 */
export function buildMergeProposal(input: {
  base: FieldMap;
  server: FieldMap;
  client: FieldMap;
  serverTimestamps: TimestampMap;
  clientTimestamps: TimestampMap;
  baseUpdatedAt: string;
}): MergeProposal {
  const merged: FieldMap = {};
  const conflicts: MergeConflict[] = [];

  const fields = new Set([
    ...Object.keys(input.server),
    ...Object.keys(input.client),
    ...Object.keys(input.base),
  ]);

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
    const winner: "server" | "client" = isAfter(clientTs ?? undefined, serverTs ?? undefined)
      ? "client"
      : "server";

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

/** 服务端当前条目（含属性）转展平字段 */
export function currentServerFields(spot: {
  categoryCode: string;
  title: string;
  description: string | null;
  attributes: unknown;
  exactLat: number;
  exactLng: number;
  fuzzEnabled: boolean;
  fuzzRadiusM: number;
  mediaUuids: string[];
}): FieldMap {
  return flattenSpotFields({
    categoryCode: spot.categoryCode,
    title: spot.title,
    description: spot.description,
    attributes: (spot.attributes ?? {}) as Record<string, unknown>,
    lat: spot.exactLat,
    lng: spot.exactLng,
    fuzzEnabled: spot.fuzzEnabled,
    fuzzRadiusM: spot.fuzzRadiusM,
    mediaUuids: spot.mediaUuids,
  });
}

export function timestampsFromRows(rows: Array<{ field: string; updatedAt: Date }>): TimestampMap {
  return Object.fromEntries(rows.map((row) => [row.field, row.updatedAt.toISOString()]));
}
