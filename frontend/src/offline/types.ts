import type { SpotDraftPayload } from "@/api/types";

/** 本地草稿记录（IndexedDB drafts store 的结构） */
export interface LocalDraft {
  /** 本地生成的草稿 ID，未补传成功前用作主键，也是幂等键的一部分 */
  clientId: string;
  /** 补传成功后对应的服务端条目 UUID；未补传为 null */
  spotUuid: string | null;
  payload: SpotDraftPayload;
  /** 逐字段最后修改时间（ISO 8601），属性键形如 attributes.has_backrest */
  fieldTimestamps: Record<string, string>;
  /** 最近一次从服务端拉到（或补传成功后）的完整内容，作为三方合并的共同基线 */
  basePayload: SpotDraftPayload | null;
  /** 基线对应的服务端 updatedAt */
  baseUpdatedAt: string | null;
  /** 本地图片 ID 列表（与服务端 mediaUuids 分开管理：补传前没有 UUID） */
  pendingImageIds: string[];
  /** 保存动作：仅存草稿 / 保存并提交审核 */
  intent: "draft" | "submit";
  /** 内容已补传成功，只剩"提交审核"动作未完成（避免重试时重复保存） */
  contentSynced: boolean;
  updatedAt: string;
  createdAt: string;
}

/** 待补传照片（IndexedDB pending-images store） */
export interface PendingImage {
  imageId: string;
  clientId: string;
  file: Blob;
  filename: string;
  mimetype: string;
  /** 补传成功后的服务端媒体 UUID */
  mediaUuid: string | null;
  /** 上传失败后的错误信息，用于在界面上提示重试 */
  lastError: string | null;
  createdAt: string;
}

export type OutboxStatus = "queued" | "uploading-images" | "syncing" | "conflict" | "error" | "done";

/** 补传队列条目：对每个有改动的草稿维护一个同步状态 */
export interface OutboxEntry {
  clientId: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  /** 失败后的退避重试时刻（ISO），在此之前 drainOutbox 跳过该条目 */
  nextAttemptAt: string | null;
  /** 冲突待用户确认时，后端 409 的原始信息 */
  conflict: unknown | null;
  updatedAt: string;
}
