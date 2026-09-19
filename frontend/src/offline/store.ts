import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isOfflineError, ApiError } from "@/api/client";
import type { Spot, SpotConflictDetails, SpotDraftPayload } from "@/api/types";
import {
  STORE_DRAFTS,
  STORE_OUTBOX,
  STORE_PENDING_IMAGES,
  idbDelete,
  idbGetAll,
  idbGetAllByIndex,
  idbPut,
} from "./db";
import type { LocalDraft, OutboxEntry, PendingImage } from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

function newClientId(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export type SyncOutcome = boolean | { autoRejected: true; spot: Spot };

/**
 * 移动端离线草稿 + 断网补传。
 *
 * 保存路径（saveDraft）：
 * 1. 任何保存都先写 IndexedDB（本地不丢）；
 * 2. 在线时立即补传，离线则进入队列；
 * 3. 联网恢复 / 页面重新打开时自动 drain 队列；
 * 4. 多端冲突（409）不自动覆盖，挂起队列并弹出合并对话框，用户确认后才入库。
 */
export const useOfflineStore = defineStore("offline", () => {
  const online = ref(typeof navigator === "undefined" ? true : navigator.onLine);
  const drafts = ref<LocalDraft[]>([]);
  const outbox = ref<OutboxEntry[]>([]);
  const images = ref<PendingImage[]>([]);
  /** 待用户确认的冲突（同一时刻只处理一个，确认完再看下一个） */
  const pendingConflict = ref<
    | (SpotConflictDetails & { clientId: string; intent: "draft" | "submit" })
    | null
  >(null);
  const syncing = ref(false);
  /** 最近一次后台补传中被自动预检拦下的草稿 clientId（编辑页据此拉取预检结果） */
  const pendingAutoRejectDraft = ref<string | null>(null);

  const pendingCount = computed(
    () => outbox.value.filter((entry) => entry.status !== "done" && entry.status !== "conflict").length,
  );
  const conflictCount = computed(() => outbox.value.filter((entry) => entry.status === "conflict").length);
  const hasLocalDrafts = computed(() => drafts.value.length > 0);

  // ---- 网络状态 -------------------------------------------------------

  function updateOnline() {
    online.value = navigator.onLine;
    if (navigator.onLine) void drainOutbox();
  }

  function startNetworkWatch() {
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    // 移动端切后台再回来时网络可能已经恢复（online 事件未必触发），
    // 页面重新可见时也尝试补传一次，由 drainOutbox 自己做幂等与退避判断
    document.addEventListener("visibilitychange", handleVisibility);
  }

  function handleVisibility() {
    if (document.visibilityState === "visible" && navigator.onLine) void drainOutbox();
  }

  function stopNetworkWatch() {
    window.removeEventListener("online", updateOnline);
    window.removeEventListener("offline", updateOnline);
    document.removeEventListener("visibilitychange", handleVisibility);
  }

  // ---- 装载 -----------------------------------------------------------

  async function hydrate(): Promise<void> {
    try {
      const [storedDrafts, storedImages, storedOutbox] = await Promise.all([
        idbGetAll<LocalDraft>(STORE_DRAFTS),
        idbGetAll<PendingImage>(STORE_PENDING_IMAGES),
        idbGetAll<OutboxEntry>(STORE_OUTBOX),
      ]);
      drafts.value = storedDrafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      images.value = storedImages;
      outbox.value = storedOutbox;
    } catch (error) {
      // IndexedDB 不可用时退化为纯在线编辑，不阻断主流程
      console.warn("离线存储不可用", error);
    }
  }

  function getDraft(clientId: string): LocalDraft | undefined {
    return drafts.value.find((draft) => draft.clientId === clientId);
  }

  function getDraftBySpot(spotUuid: string): LocalDraft | undefined {
    return drafts.value.find((draft) => draft.spotUuid === spotUuid);
  }

  async function persistDraft(draft: LocalDraft): Promise<void> {
    draft.updatedAt = nowIso();
    const index = drafts.value.findIndex((item) => item.clientId === draft.clientId);
    if (index >= 0) drafts.value[index] = draft;
    else drafts.value.unshift(draft);
    await idbPut(STORE_DRAFTS, draft);
  }

  async function upsertOutbox(
    clientId: string,
    patch: Partial<OutboxEntry> & Pick<OutboxEntry, "status">,
  ): Promise<void> {
    const existing = outbox.value.find((entry) => entry.clientId === clientId);
    const patchDefined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<OutboxEntry> & Pick<OutboxEntry, "status">;
    const next: OutboxEntry = {
      clientId,
      attempts: existing?.attempts ?? 0,
      lastError: existing?.lastError ?? null,
      nextAttemptAt: existing?.nextAttemptAt ?? null,
      conflict: existing?.conflict ?? null,
      updatedAt: nowIso(),
      ...existing,
      ...patchDefined,
    };
    const index = outbox.value.findIndex((entry) => entry.clientId === clientId);
    if (index >= 0) outbox.value[index] = next;
    else outbox.value.push(next);
    await idbPut(STORE_OUTBOX, next);
  }

  async function removeOutbox(clientId: string): Promise<void> {
    outbox.value = outbox.value.filter((entry) => entry.clientId !== clientId);
    await idbDelete(STORE_OUTBOX, clientId);
  }

  // ---- 本地草稿写入 ---------------------------------------------------

  /**
   * 保存草稿。在线时走服务端，离线/网络失败时落本地并进入补传队列。
   * 返回保存后的草稿（调用方据此拿到 clientId / spotUuid）。
   */
  async function saveDraft(input: {
    clientId?: string | null;
    spotUuid?: string | null;
    payload: SpotDraftPayload;
    fieldTimestamps: Record<string, string>;
    basePayload?: SpotDraftPayload | null;
    baseUpdatedAt?: string | null;
    intent?: "draft" | "submit";
  }): Promise<{ draft: LocalDraft; synced: boolean }> {
    const existing =
      (input.clientId ? getDraft(input.clientId) : undefined) ??
      (input.spotUuid ? getDraftBySpot(input.spotUuid) : undefined);

    const draft: LocalDraft = existing
      ? {
          ...existing,
          payload: input.payload,
          fieldTimestamps: { ...existing.fieldTimestamps, ...input.fieldTimestamps },
          basePayload: input.basePayload !== undefined ? input.basePayload : existing.basePayload,
          baseUpdatedAt: input.baseUpdatedAt !== undefined ? input.baseUpdatedAt : existing.baseUpdatedAt,
          intent: input.intent ?? existing.intent,
          // 又有了新的本地改动，上一轮的"内容已入库"状态失效
          contentSynced: false,
        }
      : {
          clientId: input.clientId ?? newClientId(),
          spotUuid: input.spotUuid ?? null,
          payload: input.payload,
          fieldTimestamps: input.fieldTimestamps,
          basePayload: input.basePayload ?? null,
          baseUpdatedAt: input.baseUpdatedAt ?? null,
          pendingImageIds: [],
          intent: input.intent ?? "draft",
          contentSynced: false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

    await persistDraft(draft);

    if (!online.value) {
      await upsertOutbox(draft.clientId, { status: "queued", lastError: null });
      return { draft, synced: false };
    }

    const outcome = await syncOne(draft);
    return { draft, synced: outcome !== false };
  }

  async function deleteLocalDraft(clientId: string): Promise<void> {
    const pending = images.value.filter((image) => image.clientId === clientId);
    await Promise.all(pending.map((image) => idbDelete(STORE_PENDING_IMAGES, image.imageId)));
    images.value = images.value.filter((image) => image.clientId !== clientId);
    drafts.value = drafts.value.filter((draft) => draft.clientId !== clientId);
    await idbDelete(STORE_DRAFTS, clientId);
    await removeOutbox(clientId);
  }

  // ---- 待补传图片 -----------------------------------------------------

  async function addPendingImage(clientId: string, file: File): Promise<PendingImage> {
    const image: PendingImage = {
      imageId: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      clientId,
      file,
      filename: file.name,
      mimetype: file.type,
      mediaUuid: null,
      lastError: null,
      createdAt: nowIso(),
    };
    images.value.push(image);
    await idbPut(STORE_PENDING_IMAGES, image);

    // 先拍照后保存也是合法路径：照片挂上来时草稿可能还没建立，
    // 这里补建一个最小草稿，保证照片不会成为无人认领的孤儿数据。
    let draft = getDraft(clientId);
    if (!draft) {
      draft = {
        clientId,
        spotUuid: null,
        payload: {
          categoryCode: "",
          title: "",
          description: "",
          attributes: {},
          lat: 0,
          lng: 0,
          fuzzEnabled: true,
          fuzzRadiusM: 50,
          mediaUuids: [],
        },
        fieldTimestamps: {},
        basePayload: null,
        baseUpdatedAt: null,
        pendingImageIds: [],
        intent: "draft",
        contentSynced: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
    }
    if (!draft.pendingImageIds.includes(image.imageId)) {
      draft.pendingImageIds.push(image.imageId);
      await persistDraft(draft);
    }
    return image;
  }

  async function getPendingImages(clientId: string): Promise<PendingImage[]> {
    return idbGetAllByIndex<PendingImage>(STORE_PENDING_IMAGES, "clientId", clientId);
  }

  async function removePendingImage(imageId: string): Promise<void> {
    images.value = images.value.filter((image) => image.imageId !== imageId);
    await idbDelete(STORE_PENDING_IMAGES, imageId);
  }

  // ---- 补传 -----------------------------------------------------------

  /** 先把本地图片补传上去，返回「本地 imageId -> 服务端 mediaUuid」映射 */
  async function uploadPendingImages(draft: LocalDraft): Promise<Map<string, string>> {
    const mapping = new Map<string, string>();
    const pending = await getPendingImages(draft.clientId);

    for (const image of pending) {
      if (image.mediaUuid) {
        mapping.set(image.imageId, image.mediaUuid);
        continue;
      }
      const formData = new FormData();
      formData.append("files", image.file, image.filename);
      try {
        const result = await api.upload<{
          assets: Array<{ uuid: string }>;
          failures: Array<{ name: string; message: string }>;
        }>("/uploads/images", formData);
        const uuid = result.assets[0]?.uuid;
        if (!uuid) throw new Error(result.failures[0]?.message ?? "图片上传失败");
        const updated: PendingImage = { ...image, mediaUuid: uuid, lastError: null };
        images.value = images.value.map((item) => (item.imageId === image.imageId ? updated : item));
        await idbPut(STORE_PENDING_IMAGES, updated);
        mapping.set(image.imageId, uuid);
      } catch (error) {
        if (isOfflineError(error)) throw error;
        // 单张图片被服务端拒绝（格式/体积等），记录原因并让队列停下提示用户，
        // 不能把这种错误静默重试到天荒地老
        image.lastError = error instanceof Error ? error.message : "图片上传失败";
        await idbPut(STORE_PENDING_IMAGES, image);
        throw error;
      }
    }
    return mapping;
  }

  /**
   * 同步单条草稿。
   * @returns true 已与服务端一致；false 未同步（离线/错误/冲突）；{ autoRejected } 已保存但自动预检未通过
   */
  async function syncOne(draft: LocalDraft): Promise<SyncOutcome> {
    if (!online.value) return false;

    // 图片可能是"先拍照后保存"挂上来的，补传前以 pendingImageIds 为准补齐 mediaUuids，
    // 否则照片传完也不会随条目提交
    let mutated = false;
    for (const imageId of draft.pendingImageIds) {
      if (!draft.payload.mediaUuids.includes(imageId)) {
        draft.payload.mediaUuids.push(imageId);
        mutated = true;
      }
    }
    if (mutated) await persistDraft(draft);

    // 只有照片、还没填任何内容的最小草稿不补传：等用户补完标题/分类再说，
    // 否则会被服务端 400 拒绝并在队列里反复报错
    if (!draft.payload.categoryCode || draft.payload.title.trim().length < 2) {
      await upsertOutbox(draft.clientId, {
        status: "queued",
        lastError: "请先补全分类与标题后再补传",
      });
      return false;
    }

    const entry = outbox.value.find((item) => item.clientId === draft.clientId);
    const attempts = (entry?.attempts ?? 0) + 1;
    await upsertOutbox(draft.clientId, {
      status: draft.pendingImageIds.length > 0 ? "uploading-images" : "syncing",
      attempts,
      lastError: null,
      nextAttemptAt: null,
    });

    try {
      let spot: Spot | null = null;

      if (draft.contentSynced && draft.spotUuid) {
        // 上一轮内容已补传成功，只差"提交审核"，不能再 PATCH 一遍
        spot = await api.get<Spot>(`/spots/${draft.spotUuid}`);
      } else {
        // 1) 先补传本地图片，把草稿里引用的本地 imageId 换成服务端 UUID
        const imageMap = await uploadPendingImages(draft);
        const mediaUuids = draft.payload.mediaUuids
          .map((ref) => imageMap.get(ref) ?? ref)
          .filter((ref) => !ref.startsWith("local-") && !ref.startsWith("img-"));

        const payload = { ...draft.payload, mediaUuids };

        if (draft.spotUuid) {
          // 2a) 已存在的条目：带乐观并发基线补传
          spot = await api.patch<Spot>(`/spots/${draft.spotUuid}`, {
            ...payload,
            baseUpdatedAt: draft.baseUpdatedAt ?? undefined,
            fieldTimestamps: draft.fieldTimestamps,
          });
        } else {
          // 2b) 本地新草稿：幂等键由 clientId 派生，断网重试多少次都只会创建一条
          spot = await api.post<Spot>(
            "/spots",
            { ...payload, fieldTimestamps: draft.fieldTimestamps },
            { idempotencyKey: `spot-create:${draft.clientId}` },
          );
        }

        await afterSyncSuccess(draft, spot);
      }

      // 3) 保存成功后若用户原意是"提交审核"，继续提交。
      if (draft.intent === "submit") {
        try {
          const result = await api.post<{ status: string }>(`/spots/${spot.uuid}/submit`);
          if (result.status === "pending" || result.status === "in_review") {
            await deleteLocalDraft(draft.clientId);
            return true;
          }
          // 自动预检未通过：条目回到可编辑状态，本地草稿保留并退出补传队列。
          // 内容本身已同步成功，返回 true 让编辑页正常展示预检结果，
          // 但不跳走、不发成功通知（调用方会重新拉取 autoCheck 状态由页面处理）。
          const retained: LocalDraft = { ...draft, spotUuid: spot.uuid, intent: "draft", contentSynced: true };
          await persistDraft(retained);
          await removeOutbox(draft.clientId);
          return { autoRejected: true as const, spot };
        } catch (error) {
          // 保存已成功，只是提交这一步失败：保留本地草稿，标为待重试，
          // 不把已入库的内容回滚
          const retained: LocalDraft = { ...draft, spotUuid: spot.uuid, intent: "submit", contentSynced: true };
          await persistDraft(retained);
          if (isOfflineError(error)) {
            await upsertOutbox(draft.clientId, { status: "queued", lastError: "已保存，等待联网后提交审核" });
          } else {
            await upsertOutbox(draft.clientId, {
              status: "error",
              lastError: error instanceof Error ? error.message : "提交审核失败",
              nextAttemptAt: new Date(Date.now() + 30_000).toISOString(),
            });
          }
          return false;
        }
      }

      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "SPOT_VERSION_CONFLICT") {
        // 多端冲突：挂起队列，等用户在合并对话框里确认最终结果
        const details = error.details as SpotConflictDetails;
        pendingConflict.value = { ...details, clientId: draft.clientId, intent: draft.intent };
        await upsertOutbox(draft.clientId, {
          status: "conflict",
          conflict: error.details,
          lastError: error.message,
        });
        return false;
      }

      if (isOfflineError(error)) {
        await upsertOutbox(draft.clientId, {
          status: "queued",
          lastError: "网络不可用，等待联网后自动补传",
          // 网络层失败等 online 事件触发即可，不做时间退避
          nextAttemptAt: null,
        });
        return false;
      }

      // 服务端错误（4xx/5xx）用指数退避：30s、60s、120s……封顶 30 分钟，
      // 避免草稿有问题时不停打服务端；用户在"我的记录"里点立即补传可强制重试
      const backoffSeconds = Math.min(30 * Math.pow(2, Math.min(attempts - 1, 6)), 30 * 60);
      await upsertOutbox(draft.clientId, {
        status: "error",
        lastError: error instanceof Error ? error.message : "补传失败",
        nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
      });
      return false;
    } finally {
      syncing.value = false;
    }
  }

  /** 同步成功后的本地状态收敛：记录基线、清队列与已补传图片 */
  async function afterSyncSuccess(draft: LocalDraft, spot: Spot): Promise<void> {
    const synced: LocalDraft = {
      ...draft,
      spotUuid: spot.uuid,
      payload: spotToPayload(spot),
      basePayload: spotToPayload(spot),
      baseUpdatedAt: spot.updatedAt,
      fieldTimestamps: spot.fieldTimestamps ?? draft.fieldTimestamps,
      pendingImageIds: [],
      contentSynced: true,
    };
    await persistDraft(synced);

    const pending = await getPendingImages(draft.clientId);
    await Promise.all(pending.map((image) => idbDelete(STORE_PENDING_IMAGES, image.imageId)));
    images.value = images.value.filter((image) => image.clientId !== draft.clientId);

    if (synced.intent === "draft") {
      // 只存草稿：本地保留一份与服务端一致的快照作为下次合并基线，不进队列
      await removeOutbox(draft.clientId);
    }
  }

  /**
   * 清空补传队列（恢复联网时调用）。
   * @param force 忽略退避窗口立即重试（用户手动触发）
   */
  async function drainOutbox(force = false): Promise<void> {
    if (!online.value || syncing.value) return;
    syncing.value = true;
    try {
      if (outbox.value.length === 0) await hydrate();
      const now = Date.now();
      for (const entry of [...outbox.value]) {
        if (!navigator.onLine) break;
        if (entry.status === "conflict") continue; // 等用户确认
        if (!force && entry.nextAttemptAt && new Date(entry.nextAttemptAt).getTime() > now) continue;
      const draft = getDraft(entry.clientId);
      if (draft) {
        const outcome = await syncOne(draft);
        if (outcome && typeof outcome === "object" && outcome.autoRejected) {
          // 后台补传的提交被自动预检拦下：通知当前编辑页展示预检结果
          pendingAutoRejectDraft.value = draft.clientId;
          window.dispatchEvent(
            new CustomEvent("psdm:auto-rejected", {
              detail: { clientId: draft.clientId, spotUuid: outcome.spot.uuid },
            }),
          );
        }
      }
      }
    } finally {
      syncing.value = false;
    }
  }

  async function retryNow(): Promise<void> {
    await drainOutbox(true);
  }

  // ---- 冲突确认 -------------------------------------------------------

  function dismissConflict(): void {
    pendingConflict.value = null;
  }

  /**
   * 用户在合并对话框确认最终结果后调用：
   * 以服务端最新版本为基线，把确认后的字段一次性合并入库。
   */
  async function resolveConflict(
    clientId: string,
    confirmedFields: Record<string, unknown>,
    confirmedTimestamps: Record<string, string>,
    serverUpdatedAt: string,
  ): Promise<boolean> {
    const draft = getDraft(clientId);
    const conflict = pendingConflict.value;
    if (!draft || !conflict) return false;

    try {
      const spot = await api.post<Spot>(`/spots/${draft.spotUuid ?? conflict.spotUuid}/merge`, {
        fields: confirmedFields,
        baseUpdatedAt: serverUpdatedAt,
        fieldTimestamps: confirmedTimestamps,
      });

      // afterSyncSuccess 会把本地载荷与基线刷新为服务端最新版本
      await afterSyncSuccess({ ...draft, intent: conflict.intent }, spot);

      pendingConflict.value = null;
      if (conflict.intent === "submit") {
        try {
          const result = await api.post<{ status: string }>(`/spots/${spot.uuid}/submit`);
          if (result.status === "pending" || result.status === "in_review") {
            await deleteLocalDraft(clientId);
          } else {
            // 自动预检未通过：保留本地草稿，让用户按提示修改后重提
            await removeOutbox(clientId);
          }
        } catch (error) {
          if (!isOfflineError(error)) throw error;
          // 合并已入库但提交没发出去：进入普通补传队列，下轮只补提交动作
          await upsertOutbox(clientId, { status: "queued", lastError: "已保存，等待联网后提交审核" });
        }
      } else {
        await removeOutbox(clientId);
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // 确认期间又有一端写入：刷新冲突信息，让用户基于最新状态再确认一次
        const details = error.details as SpotConflictDetails;
        pendingConflict.value = {
          ...details,
          clientId,
          intent: conflict.intent,
        };
        await upsertOutbox(clientId, { status: "conflict", conflict: error.details, lastError: error.message });
      } else {
        throw error;
      }
      return false;
    }
  }

  return {
    online,
    syncing,
    pendingAutoRejectDraft,
    drafts,
    outbox,
    images,
    pendingConflict,
    pendingCount,
    conflictCount,
    hasLocalDrafts,
    startNetworkWatch,
    stopNetworkWatch,
    hydrate,
    getDraft,
    getDraftBySpot,
    saveDraft,
    deleteLocalDraft,
    addPendingImage,
    getPendingImages,
    removePendingImage,
    drainOutbox,
    retryNow,
    syncOne,
    resolveConflict,
    dismissConflict,
  };
});

// ---- 转换工具 ---------------------------------------------------------

export function spotToPayload(spot: Spot): SpotDraftPayload {
  return {
    categoryCode: spot.category.code,
    title: spot.title,
    description: spot.description ?? "",
    attributes: { ...spot.attributes },
    lat: spot.location.lat,
    lng: spot.location.lng,
    fuzzEnabled: spot.location.fuzzEnabled,
    fuzzRadiusM: spot.location.radiusMeters,
    mediaUuids: spot.media.map((asset) => asset.uuid),
  };
}

/** 合并对话框确认的展平字段转成草稿载荷补丁 */
export function fieldsToPayloadPatch(fields: Record<string, unknown>): Partial<SpotDraftPayload> {
  const patch: Partial<SpotDraftPayload> = { attributes: {} };
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("attributes.")) {
      patch.attributes![key.slice("attributes.".length)] = value;
    } else {
      (patch as Record<string, unknown>)[key] = value;
    }
  }
  return patch;
}
