import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  deleteMedia,
  getDraft,
  listDrafts,
  makeLocalId,
  pruneOrphanMedia,
  putDraft,
  putMedia,
  type LocalDraft,
  type PendingPhoto,
} from "@/offline/db";
import { isOnline } from "@/offline/network";
import { syncQueue } from "@/offline/queue";
import type { FieldTimestamps, MergeFieldKey, SpotDraftPayload } from "@/offline/merge";

export interface DraftFormData {
  categoryCode: string;
  title: string;
  description: string;
  attributes: Record<string, unknown>;
  lat: number;
  lng: number;
  fuzzEnabled: boolean;
  fuzzRadiusM: number;
}

export const ALL_MERGE_FIELDS: MergeFieldKey[] = [
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

export function draftKeyFor(spotUuid: string | null): string {
  return spotUuid ? spotUuid : `new:${makeLocalId()}`;
}

function emptyForm(): DraftFormData {
  return {
    categoryCode: "",
    title: "",
    description: "",
    attributes: {},
    lat: 0,
    lng: 0,
    fuzzEnabled: true,
    fuzzRadiusM: 50,
  };
}

export const useDraftStore = defineStore("offline-drafts", () => {
  const drafts = ref<LocalDraft[]>([]);
  const loaded = ref(false);

  const pendingCount = computed(() => drafts.value.filter((draft) => draft.status !== "synced").length);
  const conflictCount = computed(() => drafts.value.filter((draft) => draft.status === "conflict").length);
  const errorCount = computed(() => drafts.value.filter((draft) => draft.status === "error").length);

  async function refresh(): Promise<void> {
    drafts.value = await listDrafts();
    loaded.value = true;
  }

  function get(key: string): Promise<LocalDraft | undefined> {
    return getDraft(key);
  }

  /**
   * 落一份本地草稿。
   * @param key       草稿键（已存在条目用 uuid，新建用 "new:..."）
   * @param form      表单字段
   * @param mediaUuids 已上传图片 uuid
   * @param touched   本次相对上一次保存发生变化的字段（记时间戳用于多端合并）
   * @param meta      已存在条目的服务端版本信息
   */
  async function save(
    key: string,
    form: DraftFormData,
    mediaUuids: string[],
    touched: MergeFieldKey[] = ALL_MERGE_FIELDS,
    meta?: { spotUuid?: string | null; baseUpdatedAt?: string | null; baseline?: FieldTimestamps },
  ): Promise<LocalDraft> {
    const now = Date.now();
    const existing = await getDraft(key);

    const fieldTimestamps: FieldTimestamps = { ...(existing?.fieldTimestamps ?? {}) };
    for (const field of touched) fieldTimestamps[field] = now;
    // 媒体列表的变化由调用方在增删图片时显式标记
    if (touched.includes("mediaUuids")) fieldTimestamps.mediaUuids = now;

    const draft: LocalDraft = {
      key,
      spotUuid: meta?.spotUuid ?? existing?.spotUuid ?? null,
      categoryCode: form.categoryCode,
      title: form.title,
      description: form.description,
      attributes: form.attributes,
      lat: form.lat,
      lng: form.lng,
      fuzzEnabled: form.fuzzEnabled,
      fuzzRadiusM: form.fuzzRadiusM,
      // 调用方传入的是当前完整的服务端图片 uuid 有序列表；
      // 断网期间新增的待传图片在 pendingPhotos 里，上传成功后由同步队列并入。
      mediaUuids: [...new Set(mediaUuids)],
      pendingPhotos: existing?.pendingPhotos ?? [],
      fieldTimestamps,
      // 基线只在"首次从服务端载入"时写入，之后编辑不再覆盖——
      // 它代表的是"我这轮编辑开始前各字段的新旧程度"。
      baselineTimestamps: meta?.baseline ?? existing?.baselineTimestamps ?? {},
      baseUpdatedAt: meta?.baseUpdatedAt !== undefined ? meta.baseUpdatedAt : (existing?.baseUpdatedAt ?? null),
      status: existing?.status === "conflict" ? "conflict" : isOnline.value ? "queued" : "local",
      lastError: existing?.status === "conflict" ? existing.lastError : null,
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await putDraft(draft);
    await refresh();

    // 在线时顺手触发补传（内部有去重锁，频繁调用也安全）
    if (draft.status !== "conflict") syncQueue.kick();

    return draft;
  }

  /** 断网时选了图片：把 Blob 存进 IndexedDB，等联网后补传 */
  async function addPendingPhoto(
    draftKey: string,
    file: File,
  ): Promise<{ photo: PendingPhoto; previewUrl: string }> {
    const localId = makeLocalId();
    const photo: PendingPhoto = {
      localId,
      name: file.name || "photo.jpg",
      mimeType: file.type || "image/jpeg",
      size: file.size,
    };
    await putMedia({ localId, blob: file, createdAt: Date.now() });

    const existing = await getDraft(draftKey);
    if (existing) {
      const next: LocalDraft = {
        ...existing,
        pendingPhotos: [...existing.pendingPhotos, photo],
        updatedAt: Date.now(),
        fieldTimestamps: { ...existing.fieldTimestamps, mediaUuids: Date.now() },
      };
      await putDraft(next);
      await refresh();
    }

    return { photo, previewUrl: URL.createObjectURL(file) };
  }

  async function removePendingPhoto(draftKey: string, localId: string): Promise<void> {
    const existing = await getDraft(draftKey);
    if (!existing) return;
    await putDraft({
      ...existing,
      pendingPhotos: existing.pendingPhotos.filter((photo) => photo.localId !== localId),
      updatedAt: Date.now(),
      fieldTimestamps: { ...existing.fieldTimestamps, mediaUuids: Date.now() },
    });
    await deleteMedia(localId).catch(() => undefined);
    await refresh();
  }

  async function remove(draftKey: string): Promise<void> {
    await syncQueue.discard(draftKey);
    await refresh();
  }

  /** 清理所有草稿都不再引用的图片 Blob */
  async function pruneMedia(): Promise<void> {
    const referenced = new Set<string>();
    for (const draft of drafts.value) {
      for (const photo of draft.pendingPhotos) referenced.add(photo.localId);
    }
    await pruneOrphanMedia(referenced);
  }

  function toFormData(draft: LocalDraft): DraftFormData {
    return {
      categoryCode: draft.categoryCode,
      title: draft.title,
      description: draft.description,
      attributes: draft.attributes,
      lat: draft.lat,
      lng: draft.lng,
      fuzzEnabled: draft.fuzzEnabled,
      fuzzRadiusM: draft.fuzzRadiusM,
    };
  }

  function toPayload(draft: LocalDraft): SpotDraftPayload {
    return {
      categoryCode: draft.categoryCode,
      title: draft.title,
      description: draft.description,
      attributes: draft.attributes,
      lat: draft.lat,
      lng: draft.lng,
      fuzzEnabled: draft.fuzzEnabled,
      fuzzRadiusM: draft.fuzzRadiusM ? draft.fuzzRadiusM : 0,
      mediaUuids: draft.mediaUuids,
    };
  }

  return {
    drafts,
    loaded,
    pendingCount,
    conflictCount,
    errorCount,
    refresh,
    get,
    save,
    remove,
    addPendingPhoto,
    removePendingPhoto,
    pruneMedia,
    toFormData,
    toPayload,
    emptyForm,
  };
});
