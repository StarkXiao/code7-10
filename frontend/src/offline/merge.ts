// 多端内容冲突的字段级合并。
//
// 场景：同一账号在手机 A 上离线编辑了草稿，期间又在手机 B（或另一标签页）
// 上改了同一条。补传时不能简单地"后写覆盖"——那样会静默丢掉其中一端的修改；
// 也不能逐字段自动取新值就直接入库——用户必须看到并确认最终结果。
//
// 规则：
//   1. 每个可编辑字段各自记录最后修改时间，合并时逐字段按时间戳取较新者；
//   2. 服务端版本中、本地没有动过的字段（本地编辑基线里不存在该字段的时间戳）
//      视为"另一端改的"，直接保留服务端值，并标记为冲突字段提示用户；
//   3. 时间戳相同取本地值，但仍标记冲突让用户确认；
//   4. 合并只产出"建议结果 + 冲突清单"，真正入库前必须经用户确认。

export type MergeFieldKey =
  | "categoryCode"
  | "title"
  | "description"
  | "attributes"
  | "lat"
  | "lng"
  | "fuzzEnabled"
  | "fuzzRadiusM"
  | "mediaUuids";

/** 补传时发给服务端的草稿内容 */
export type SpotDraftPayload = Record<string, unknown> & {
  categoryCode?: string;
  title?: string;
  description?: string;
  attributes?: Record<string, unknown>;
  lat?: number;
  lng?: number;
  fuzzEnabled?: boolean;
  fuzzRadiusM?: number;
  mediaUuids?: string[];
};

/** 字段 -> 该字段最后一次在本机被修改的时间戳（epoch ms） */
export type FieldTimestamps = Partial<Record<MergeFieldKey, number>>;

export interface FieldConflict {
  field: MergeFieldKey;
  /** 合并建议采用的一方 */
  winner: "local" | "remote";
  localChangedAt: number | null;
  remoteChangedAt: number;
}

export interface MergeResult {
  /** 字段级时间戳合并后的建议内容 */
  merged: SpotDraftPayload;
  /** 需要用户确认的字段（两端都可能写过、或无法判定归属） */
  conflicts: FieldConflict[];
  /** 是否存在任何冲突 */
  hasConflict: boolean;
}

function timeOf(map: FieldTimestamps | undefined, field: MergeFieldKey): number | null {
  const value = map?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 媒体列表按"集合"合并会引入顺序/删除语义的歧义，
 * 这里仍然按时间戳二选一，但永远标记为冲突让用户过目。
 */
function isComplexField(field: MergeFieldKey): boolean {
  return field === "mediaUuids" || field === "attributes";
}

function equalLoose(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => equalLoose(item, b[index]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) if (!equalLoose(left[key], right[key])) return false;
    return true;
  }
  return false;
}

/**
 * @param local        本机离线编辑后的草稿内容
 * @param localTimes   本机各字段最后修改时间（null 表示本机没动过该字段）
 * @param remote       服务端当前内容（冲突时由 409 响应或 GET 得到）
 * @param remoteTime   服务端版本的更新时间（updatedAt, epoch ms）
 * @param baseline     本机开始编辑前的字段时间戳基线，用于判断"服务端这个字段是不是在我编辑期间被别处改了"
 */
export function mergeByTimestamp(
  local: SpotDraftPayload,
  localTimes: FieldTimestamps,
  remote: SpotDraftPayload,
  remoteTime: number,
  baseline: FieldTimestamps = {},
): MergeResult {
  const fields: MergeFieldKey[] = [
    "categoryCode",
    "title",
    "description",
    "attributes",
    "lat",
    "lng",
    "fuzzEnabled",
    "fuzzRadiusM",
    "mediaUuids",
  ];

  const merged = {} as Record<MergeFieldKey, unknown>;
  const conflicts: FieldConflict[] = [];

  for (const field of fields) {
    const localHas = field in local;
    const remoteHas = field in remote;
    if (!localHas && !remoteHas) continue;

    const localChangedAt = timeOf(localTimes, field);
    const baseChangedAt = timeOf(baseline, field);

    // 本机从未编辑过该字段：一律以服务端为准。
    // 仅当本机编辑开始时该字段已存在（说明用户见过旧值）、
    // 且远端在编辑期间确实换过内容时，才提示确认。
    if (localChangedAt === null) {
      if (remoteHas) merged[field] = remote[field];
      if (remoteHas && baseChangedAt !== null && baseChangedAt < remoteTime) {
        conflicts.push({ field, winner: "remote", localChangedAt: null, remoteChangedAt: remoteTime });
      }
      continue;
    }

    if (!remoteHas) {
      merged[field] = local[field];
      continue;
    }

    // 远端比本机基线还旧或相同：远端没动过这个字段，直接用本机值。
    // 注意 attributes/media 这类复合字段无法可靠做细粒度 diff，保守起见仍交给用户确认。
    const remoteUnchangedSinceBase = baseChangedAt !== null && remoteTime <= baseChangedAt;
    if (equalLoose(local[field], remote[field])) {
      merged[field] = local[field];
      continue;
    }

    if (remoteUnchangedSinceBase && !isComplexField(field)) {
      merged[field] = local[field];
      continue;
    }

    // 两端都写过且值不同：按时间戳选建议值，但必须用户确认。
    // 平局时倾向本机内容（用户此刻正在这台设备上操作）。
    const winner: "local" | "remote" = localChangedAt >= remoteTime ? "local" : "remote";
    merged[field] = winner === "local" ? local[field] : remote[field];
    conflicts.push({ field, winner, localChangedAt, remoteChangedAt: remoteTime });
  }

  return { merged: merged as SpotDraftPayload, conflicts, hasConflict: conflicts.length > 0 };
}

/** 把 Spot（GET /spots/:uuid 的响应）转成可合并的草稿形态 */
export function spotToDraftPayload(spot: {
  category: { code: string };
  title: string;
  description: string | null;
  attributes: Record<string, unknown>;
  location: { lat: number; lng: number; fuzzed: boolean; radiusMeters: number };
  media: Array<{ uuid: string }>;
}): SpotDraftPayload {
  return {
    categoryCode: spot.category.code,
    title: spot.title,
    description: spot.description ?? "",
    attributes: { ...spot.attributes },
    lat: spot.location.lat,
    lng: spot.location.lng,
    fuzzEnabled: spot.location.fuzzed || spot.location.radiusMeters > 0,
    fuzzRadiusM: spot.location.radiusMeters || 50,
    mediaUuids: spot.media.map((asset) => asset.uuid),
  };
}
