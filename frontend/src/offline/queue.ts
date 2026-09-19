// 离线补传队列。
//
// 职责：
//   1. 草稿在本地保存后进入队列；网络恢复、页面重新可见、登录成功后自动触发；
//   2. 按草稿更新时间从旧到新依次补传，同一草稿内先传图片、再写条目；
//   3. 失败按指数退避重试（断网/5xx/429），参数或权限类错误（4xx）不重试；
//   4. PATCH 撞 409（多端内容冲突）时不覆盖任何一方，挂起草稿并通知 UI 弹出
//      合并确认——用户确认最终结果后才带着新版本入库。
//
// 这一层不依赖 Vue 组件；弹窗由组件侧监听冲突事件完成。

import {
  deleteDraft,
  deleteMedia,
  getDraft,
  getMedia,
  listDrafts,
  putDraft,
  type LocalDraft,
} from "./db";
import { isOnline, onNetworkChange, setOnline } from "./network";
import { mergeByTimestamp, spotToDraftPayload, type SpotDraftPayload } from "./merge";
import { ApiError, api } from "@/api/client";
import type { Spot } from "@/api/types";

export type QueueState = "idle" | "syncing" | "waiting";

export interface SyncOutcome {
  key: string;
  status: "synced" | "conflict" | "error";
  message?: string;
  spotUuid?: string;
}

export interface ConflictContext {
  draft: LocalDraft;
  serverSpot: Spot;
  proposal: { merged: SpotDraftPayload; remote: SpotDraftPayload; local: SpotDraftPayload };
}

type OutcomeListener = (outcome: SyncOutcome) => void;

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** 等待用户处理的冲突上下文（key -> context），由冲突弹窗读取 */
export const conflictCache = new Map<string, ConflictContext>();
/** 刚同步成功的服务端版本，供仍停留在编辑页的组件接上 updatedAt */
export const lastSyncedCache = new Map<string, { spotUuid: string; updatedAt: string }>();

export function isRetryableError(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.status === 409) return false; // 冲突必须人工合并，不能盲目重试
    if (error.status === 429) return true;
    return error.status >= 500;
  }
  // fetch 在断网/DNS 失败时抛 TypeError，没有状态码，按可重试处理
  return true;
}

function backoffDelay(attempts: number): number {
  const expo = BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(expo, MAX_BACKOFF_MS);
}

function draftPayload(draft: LocalDraft): SpotDraftPayload {
  return {
    categoryCode: draft.categoryCode,
    title: draft.title,
    description: draft.description,
    attributes: draft.attributes,
    lat: draft.lat,
    lng: draft.lng,
    fuzzEnabled: draft.fuzzEnabled,
    fuzzRadiusM: draft.fuzzEnabled ? draft.fuzzRadiusM : 0,
    mediaUuids: draft.mediaUuids,
  };
}

class SyncQueue {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<OutcomeListener>();
  readonly state: { value: QueueState } = { value: "idle" };

  onOutcome(listener: OutcomeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(outcome: SyncOutcome): void {
    for (const listener of this.listeners) listener(outcome);
  }

  /** 网络恢复/手动触发时调用；已有任务在跑或离线时直接返回 */
  kick(): void {
    if (!isOnline.value || this.running) return;
    this.run().catch(() => undefined);
  }

  async syncOne(key: string): Promise<SyncOutcome | null> {
    const draft = await getDraft(key);
    if (!draft) return null;
    return this.processDraft(draft);
  }

  /** 放弃一条本地草稿（同时清理它独占的待传图片） */
  async discard(key: string): Promise<void> {
    const draft = await getDraft(key);
    if (draft) {
      await Promise.all(draft.pendingPhotos.map((photo) => deleteMedia(photo.localId).catch(() => undefined)));
    }
    conflictCache.delete(key);
    await deleteDraft(key);
  }

  /**
   * 冲突确认后用用户拍板的内容入库。
   * 此时故意不带 baseUpdatedAt：用户已经看过服务端最新版本，
   * 安全性来自"必须显式确认"，而不是静默覆盖。
   */
  async resolveConflict(key: string, finalPayload: SpotDraftPayload): Promise<SyncOutcome> {
    const draft = await getDraft(key);
    if (!draft) return { key, status: "error", message: "本地草稿已不存在" };
    if (!draft.spotUuid) return { key, status: "error", message: "草稿尚未在服务端创建，无法合并" };

    try {
      const spot = await api.patch<Spot>(`/spots/${draft.spotUuid}`, { ...finalPayload });
      await this.afterSynced(draft, spot);
      conflictCache.delete(key);
      const outcome: SyncOutcome = { key, status: "synced", spotUuid: spot.uuid };
      this.emit(outcome);
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : "合并保存失败";
      await putDraft({ ...draft, status: "error", lastError: message });
      const outcome: SyncOutcome = { key, status: "error", message };
      this.emit(outcome);
      return outcome;
    }
  }

  private scheduleRetry(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.state.value = "waiting";
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, delayMs);
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.state.value = "syncing";

    try {
      const drafts = await listDrafts();
      const pending = drafts
        .filter((draft) => draft.status === "queued" || draft.status === "syncing" || draft.status === "error")
        .sort((a, b) => a.updatedAt - b.updatedAt);

      let retryAgain = false;
      let maxAttempts = 0;

      for (const draft of pending) {
        if (!isOnline.value) {
          retryAgain = true;
          break;
        }
        const outcome = await this.processDraft(draft);
        if (outcome.status === "error") {
          retryAgain = true;
          maxAttempts = Math.max(maxAttempts, draft.attempts);
        }
      }

      if (!isOnline.value || retryAgain) {
        // 离线：等 online 事件；在线但有失败：指数退避后再来一轮
        if (isOnline.value) this.scheduleRetry(backoffDelay(maxAttempts + 1));
        else this.state.value = "waiting";
      } else {
        this.state.value = "idle";
      }
    } finally {
      this.running = false;
    }
  }

  private async processDraft(draft: LocalDraft): Promise<SyncOutcome> {
    if (!isOnline.value) return { key: draft.key, status: "error", message: "当前处于离线状态" };

    let working: LocalDraft = { ...draft, status: "syncing", attempts: draft.attempts + 1, lastError: null };
    await putDraft(working);

    try {
      // 1) 断网期间选的图片先传，成功一张就把 Blob 删掉并落 uuid
      for (const photo of working.pendingPhotos.filter((item) => !item.serverUuid)) {
        const record = await getMedia(photo.localId);
        if (!record) {
          // Blob 可能被浏览器存储回收：剔除引用，其余内容照常补传
          working.pendingPhotos = working.pendingPhotos.filter((item) => item.localId !== photo.localId);
          continue;
        }
        const formData = new FormData();
        formData.append("files", record.blob, photo.name);
        const result = await api.upload<{
          assets: Array<{ uuid: string }>;
          failures: Array<{ name: string; message: string }>;
        }>("/uploads/images", formData);

        if (result.assets[0]) {
          const uuid = result.assets[0].uuid;
          const target = working.pendingPhotos.find((item) => item.localId === photo.localId);
          if (target) target.serverUuid = uuid;
          if (!working.mediaUuids.includes(uuid)) working.mediaUuids.push(uuid);
          await putDraft(working);
          await deleteMedia(photo.localId).catch(() => undefined);
        } else {
          throw new Error(result.failures[0]?.message ?? "图片上传失败");
        }
      }
      working.pendingPhotos = working.pendingPhotos.filter((photo) => photo.serverUuid);

      // 2) 写条目：新建带幂等键，更新带乐观锁版本号
      let spot: Spot;
      if (working.spotUuid) {
        spot = await this.patchExisting(working);
      } else {
        const clientKey = working.key.startsWith("new:") ? working.key.slice(4) : working.key;
        spot = await api.post<Spot>("/spots", { ...draftPayload(working), clientKey });
        working.spotUuid = spot.uuid;
      }

      await this.afterSynced(working, spot);
      const outcome: SyncOutcome = { key: working.key, status: "synced", spotUuid: spot.uuid };
      this.emit(outcome);
      return outcome;
    } catch (error) {
      return this.handleFailure(working, error);
    }
  }

  private async patchExisting(draft: LocalDraft): Promise<Spot> {
    try {
      return await api.patch<Spot>(`/spots/${draft.spotUuid}`, {
        ...draftPayload(draft),
        baseUpdatedAt: draft.baseUpdatedAt ?? undefined,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const serverSpot = (error.details as { current?: Spot } | undefined)?.current;
        if (serverSpot) await this.suspendForConflict(draft, serverSpot);
      }
      throw error;
    }
  }

  private async suspendForConflict(draft: LocalDraft, serverSpot: Spot): Promise<void> {
    const remote = spotToDraftPayload(serverSpot);
    const local = draftPayload(draft);
    const remoteTime = Date.parse(serverSpot.updatedAt) || Date.now();
    const { merged } = mergeByTimestamp(
      local,
      draft.fieldTimestamps,
      remote,
      remoteTime,
      draft.baselineTimestamps,
    );

    const suspended: LocalDraft = { ...draft, status: "conflict", lastError: null };
    await putDraft(suspended);
    conflictCache.set(draft.key, { draft: suspended, serverSpot, proposal: { merged, remote, local } });
    this.emit({ key: draft.key, status: "conflict", spotUuid: draft.spotUuid ?? undefined });
  }

  private async afterSynced(draft: LocalDraft, spot: Spot): Promise<void> {
    await Promise.all(draft.pendingPhotos.map((photo) => deleteMedia(photo.localId).catch(() => undefined)));
    await deleteDraft(draft.key);
    lastSyncedCache.set(draft.key, { spotUuid: spot.uuid, updatedAt: spot.updatedAt });
  }

  private async handleFailure(draft: LocalDraft, error: unknown): Promise<SyncOutcome> {
    // fetch 级别的失败说明 navigator.onLine 说谎了，纠正后等 online 事件再补
    if (!(error instanceof ApiError)) setOnline(false);

    if (error instanceof ApiError && error.status === 409) {
      return { key: draft.key, status: "conflict", spotUuid: draft.spotUuid ?? undefined };
    }

    const retryable = isRetryableError(error);
    const message = error instanceof Error ? error.message : "同步失败";
    const exhausted = draft.attempts >= MAX_ATTEMPTS;
    const suffix = exhausted ? "（已暂停自动重试，可手动重试）" : "";
    await putDraft({ ...draft, status: "error", lastError: message + suffix });

    if (retryable && !exhausted && isOnline.value) {
      this.scheduleRetry(backoffDelay(draft.attempts));
    }

    const outcome: SyncOutcome = {
      key: draft.key,
      status: "error",
      message: message + suffix,
      spotUuid: draft.spotUuid ?? undefined,
    };
    this.emit(outcome);
    return outcome;
  }
}

export const syncQueue = new SyncQueue();

/** App 启动时调用一次：装网络/前后台监听并在有网时立刻尝试补传 */
export function startSyncQueue(): void {
  onNetworkChange((online) => {
    if (online) syncQueue.kick();
  });

  // 移动端切后台期间浏览器不派发 online 事件，回到前台时主动补一轮
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isOnline.value) syncQueue.kick();
  });

  syncQueue.kick();
}
