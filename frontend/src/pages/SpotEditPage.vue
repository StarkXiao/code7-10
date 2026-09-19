<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api, isOfflineError } from "@/api/client";
import type { AttributeSchema, Category, Spot, SpotDraftPayload } from "@/api/types";
import { useAuthStore } from "@/stores/auth";
import { useCatalogStore } from "@/stores/catalog";
import { useOfflineStore } from "@/offline/store";
import { DEFAULT_CENTER } from "@/config/map";
import AttributeForm from "@/components/AttributeForm.vue";
import LocationPicker from "@/components/LocationPicker.vue";
import PhotoUploader from "@/components/PhotoUploader.vue";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const catalog = useCatalogStore();
const offline = useOfflineStore();

const uuid = computed(() => (route.params.uuid ? String(route.params.uuid) : null));
const isEdit = computed(() => uuid.value !== null);
/** /spots/new?clientId=xxx：继续编辑尚未补传成功的本地草稿 */
const clientIdParam = computed(() => (route.query.clientId ? String(route.query.clientId) : null));

const form = ref({
  categoryCode: "",
  title: "",
  description: "",
  attributes: {} as Record<string, unknown>,
  lat: DEFAULT_CENTER[0],
  lng: DEFAULT_CENTER[1],
  fuzzEnabled: true,
  fuzzRadiusM: 50,
  mediaUuids: [] as string[],
});

const loading = ref(false);
const saving = ref(false);
const submitting = ref(false);
const spotStatus = ref<string>("draft");
const autoCheckIssues = ref<Array<{ code: string; message: string }>>([]);
const reviewFeedback = ref<string | null>(null);
const canRequestManualReview = ref(false);
const photoUploader = ref<InstanceType<typeof PhotoUploader> | null>(null);

// 离线同步相关
const clientId = ref<string>("");
const baseUpdatedAt = ref<string | null>(null);
const lastSavedAt = ref<string | null>(null);
/** 服务端拉到的共同基线（仅内存），供补传冲突时三方合并 */
const basePayloadForMerge = ref<SpotDraftPayload | null>(null);
const localPreviewUrls = new Map<string, string>();

const category = computed<Category | undefined>(() => catalog.byCode(form.value.categoryCode));
const schema = computed<AttributeSchema | null>(() => category.value?.schema ?? null);
const isOnline = computed(() => offline.online);

watch(
  () => form.value.fuzzEnabled,
  (enabled) => {
    if (!enabled) form.value.fuzzRadiusM = 0;
    else if (form.value.fuzzRadiusM === 0) form.value.fuzzRadiusM = 50;
  },
);

function buildPayload(): SpotDraftPayload {
  return {
    categoryCode: form.value.categoryCode,
    title: form.value.title.trim(),
    description: form.value.description.trim(),
    attributes: form.value.attributes,
    lat: form.value.lat,
    lng: form.value.lng,
    fuzzEnabled: form.value.fuzzEnabled,
    fuzzRadiusM: form.value.fuzzEnabled ? form.value.fuzzRadiusM : 0,
    mediaUuids: form.value.mediaUuids,
  };
}

/**
 * 本次保存的逐字段时间戳：
 * 以服务端下发的字段时间为底，本次表单里出现的字段统一推进到当前时刻。
 * 属性按 key 记录（attributes.has_backrest），多端合并时逐属性比较。
 */
function buildFieldTimestamps(previous: Record<string, string>): Record<string, string> {
  const next = { ...previous };
  const stamp = new Date().toISOString();
  next.categoryCode = stamp;
  next.title = stamp;
  next.description = stamp;
  next.lat = stamp;
  next.lng = stamp;
  next.fuzzEnabled = stamp;
  next.fuzzRadiusM = stamp;
  next.mediaUuids = stamp;
  for (const key of Object.keys(form.value.attributes)) next[`attributes.${key}`] = stamp;
  return next;
}

function applySpot(spot: Spot): SpotDraftPayload {
  form.value.categoryCode = spot.category.code;
  form.value.title = spot.title;
  form.value.description = spot.description ?? "";
  form.value.attributes = { ...spot.attributes };
  form.value.lat = spot.location.lat;
  form.value.lng = spot.location.lng;
  form.value.fuzzEnabled = spot.location.fuzzEnabled;
  form.value.fuzzRadiusM = spot.location.radiusMeters || 50;
  form.value.mediaUuids = spot.media.map((asset) => asset.uuid);
  baseUpdatedAt.value = spot.updatedAt;
  lastSavedAt.value = spot.updatedAt;
  spotStatus.value = spot.status;

  setTimeout(() => {
    photoUploader.value?.setExisting(
      spot.media.map((asset) => ({
        uuid: asset.uuid,
        variants: asset.variants,
        privacyStatus: asset.privacyStatus,
        variantVersion: asset.variantVersion,
        width: asset.width,
        height: asset.height,
      })),
    );
  }, 50);

  const payload: SpotDraftPayload = {
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
  basePayloadForMerge.value = payload;
  return payload;
}

async function showPendingImages(currentClientId: string): Promise<void> {
  const pending = await offline.getPendingImages(currentClientId);
  for (const image of pending) {
    if (!localPreviewUrls.has(image.imageId)) {
      localPreviewUrls.set(image.imageId, URL.createObjectURL(image.file));
    }
    photoUploader.value?.addLocalImage({
      localId: image.imageId,
      previewUrl: localPreviewUrls.get(image.imageId)!,
      filename: image.filename,
      mediaUuid: image.mediaUuid,
      lastError: image.lastError,
    });
  }
  // addLocalImage 会把本机 imageId 合并进 v-model，确保与草稿里记录的引用一致
  for (const image of pending) {
    if (!form.value.mediaUuids.includes(image.imageId)) form.value.mediaUuids.push(image.imageId);
  }
}

async function loadLocalDraft(localClientId: string): Promise<boolean> {
  await offline.hydrate();
  const draft = offline.getDraft(localClientId);
  if (!draft) return false;

  clientId.value = draft.clientId;
  const payload = draft.payload;
  form.value.categoryCode = payload.categoryCode;
  form.value.title = payload.title;
  form.value.description = payload.description;
  form.value.attributes = { ...payload.attributes };
  form.value.lat = payload.lat;
  form.value.lng = payload.lng;
  form.value.fuzzEnabled = payload.fuzzEnabled;
  form.value.fuzzRadiusM = payload.fuzzRadiusM;
  form.value.mediaUuids = [...payload.mediaUuids];
  baseUpdatedAt.value = draft.baseUpdatedAt;
  lastSavedAt.value = draft.updatedAt;
  basePayloadForMerge.value = draft.basePayload;

  await showPendingImages(draft.clientId);
  return true;
}

async function loadExisting() {
  if (clientIdParam.value) {
    const found = await loadLocalDraft(clientIdParam.value);
    if (found) return;
  }

  if (!uuid.value) {
    form.value.categoryCode = catalog.categories[0]?.code ?? "";
    return;
  }

  loading.value = true;
  try {
    const spot = await api.get<Spot>(`/spots/${uuid.value}`);
    const serverPayload = applySpot(spot);

    // 本地可能有这条目尚未补传成功的改动（离线编辑后换页面又回来）
    await offline.hydrate();
    const localDraft = offline.getDraftBySpot(spot.uuid);
    const inOutbox = localDraft ? offline.outbox.some((entry) => entry.clientId === localDraft.clientId) : false;
    if (localDraft && inOutbox) {
      // 只有补传队列里还有这条（待传/出错/冲突）才算"本机有尚未同步的改动"；
      // 已与服务端一致的本地快照只作为合并基线，不打扰用户。
      clientId.value = localDraft.clientId;
      const payload = localDraft.payload;
      form.value.categoryCode = payload.categoryCode;
      form.value.title = payload.title;
      form.value.description = payload.description;
      form.value.attributes = { ...payload.attributes };
      form.value.lat = payload.lat;
      form.value.lng = payload.lng;
      form.value.fuzzEnabled = payload.fuzzEnabled;
      form.value.fuzzRadiusM = payload.fuzzRadiusM;
      form.value.mediaUuids = [...payload.mediaUuids];
      baseUpdatedAt.value = localDraft.baseUpdatedAt;
      lastSavedAt.value = localDraft.updatedAt;
      basePayloadForMerge.value = localDraft.basePayload;
      await showPendingImages(localDraft.clientId);
      ElMessage.info("已载入本机尚未补传的修改，联网后会自动同步");
    } else if (localDraft) {
      // 本地留有同步快照：用它的基线，内容仍以服务端为准
      clientId.value = localDraft.clientId;
      basePayloadForMerge.value = localDraft.basePayload;
      baseUpdatedAt.value = localDraft.baseUpdatedAt ?? spot.updatedAt;
    } else {
      // 记下共同基线（内存即可）：离线/在线保存时据此做三方合并，
      // 不在 IndexedDB 留一条"什么都没改"的草稿，否则我的记录页会出现幽灵条目。
      clientId.value = `local-${spot.uuid}`;
      basePayloadForMerge.value = serverPayload;
    }

    // 把审核意见直接展示在编辑页，用户不用来回切换页面
    const revisions = await api
      .get<{ items: Array<{ review: { decisionReason: string | null; reasonCode: string | null } | null }> }>(
        `/spots/${uuid.value}/revisions`,
      )
      .catch(() => ({ items: [] }));

    const latestReview = revisions.items[0]?.review;
    if (latestReview?.decisionReason) {
      reviewFeedback.value = latestReview.decisionReason;
    }
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

function validateBeforeSubmit(): string | null {
  if (!form.value.categoryCode) return "请选择分类";
  if (form.value.title.trim().length < 2) return "请填写标题（至少 2 个字）";

  const required = schema.value?.required ?? [];
  for (const key of required) {
    const value = form.value.attributes[key];
    if (value === undefined || value === null || value === "") {
      return `请填写「${schema.value?.properties[key]?.label ?? key}」`;
    }
  }
  return null;
}

function onLocationUpdate(payload: { lat: number; lng: number }) {
  form.value.lat = payload.lat;
  form.value.lng = payload.lng;
}

/**
 * 离线时照片先存 IndexedDB：返回本地 imageId（以 img- 开头），
 * 与服务端 mediaUuid 共同放在 form.mediaUuids 里，补传成功后再替换。
 */
async function onLocalFiles(files: File[]): Promise<void> {
  if (!clientId.value) return;
  for (const file of files) {
    const image = await offline.addPendingImage(clientId.value, file);
    const url = URL.createObjectURL(file);
    localPreviewUrls.set(image.imageId, url);
    // addLocalImage 内部会同步 v-model（服务端 UUID + 本机 imageId），
    // 这里不要再手动 push，否则同一张照片会在 mediaUuids 里出现两次
    photoUploader.value?.addLocalImage({
      localId: image.imageId,
      previewUrl: url,
      filename: file.name,
      mediaUuid: null,
      lastError: null,
    });
  }
}

async function onRemoveLocalImage(localId: string): Promise<void> {
  await offline.removePendingImage(localId);
  const url = localPreviewUrls.get(localId);
  if (url) {
    URL.revokeObjectURL(url);
    localPreviewUrls.delete(localId);
  }
  // removeLocal 已通过 syncModel 更新 v-model，这里无需再改 form.mediaUuids
}

async function persistCurrent(intent: "draft" | "submit"): Promise<{
  synced: boolean;
  draftClientId: string;
  spotUuid: string | null;
}> {
  const payload = buildPayload();
  if (!clientId.value) clientId.value = clientIdParam.value ?? `local-${Date.now().toString(36)}`;

  const previousDraft = offline.getDraft(clientId.value);
  const fieldTimestamps = buildFieldTimestamps(previousDraft?.fieldTimestamps ?? {});

  const { draft, synced } = await offline.saveDraft({
    clientId: clientId.value,
    spotUuid: uuid.value ?? previousDraft?.spotUuid ?? null,
    payload,
    fieldTimestamps,
    basePayload: basePayloadForMerge.value ?? previousDraft?.basePayload ?? null,
    baseUpdatedAt: previousDraft?.baseUpdatedAt ?? baseUpdatedAt.value,
    intent,
  });

  return { synced, draftClientId: draft.clientId, spotUuid: draft.spotUuid };
}

async function onSaveDraft() {
  saving.value = true;
  try {
    const { synced, spotUuid } = await persistCurrent("draft");
    if (!offline.online || !synced) {
      ElMessage.success("草稿已保存在本机，联网后自动补传");
    } else {
      ElMessage.success("草稿已保存");
      lastSavedAt.value = new Date().toISOString();
    }

    if (!isEdit.value && spotUuid) {
      void router.replace({ name: "spot-edit", params: { uuid: spotUuid } });
    }
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    saving.value = false;
  }
}

async function onSubmit() {
  const error = validateBeforeSubmit();
  if (error) {
    ElMessage.warning(error);
    return;
  }

  submitting.value = true;
  try {
    const { synced, spotUuid } = await persistCurrent("submit");

    if (!synced) {
      const entry = offline.outbox.find((item) => item.clientId === clientId.value);
      if (!offline.online) {
        ElMessage.success("内容已保存在本机，联网补传成功后会自动提交审核");
      } else if (entry?.status === "conflict") {
        ElMessage.warning("与另一台设备的修改存在冲突，请先在弹窗里确认合并结果，确认后会自动提交");
      } else {
        ElMessage.warning(entry?.lastError ?? "暂未同步成功，会在联网后自动重试");
      }
      if (!isEdit.value && spotUuid) {
        void router.replace({ name: "spot-edit", params: { uuid: spotUuid } });
      }
      return;
    }

    if (!spotUuid) return;

    const result = await api.post<{
      status: string;
      autoCheck: { passed: boolean; issues: Array<{ code: string; message: string }> };
      canRequestManualReview: boolean;
    }>(`/spots/${spotUuid}/submit`);

    spotStatus.value = result.status;
    autoCheckIssues.value = result.autoCheck.issues;
    canRequestManualReview.value = result.canRequestManualReview;

    if (result.autoCheck.passed) {
      ElMessage.success("已提交审核，结果会通过站内通知告诉你");
      void router.push({ name: "me" });
    } else {
      ElMessage.warning("提交前有几处需要先处理，请看下方提示");
    }
  } catch (error) {
    if (isOfflineError(error)) {
      ElMessage.success("内容已保存在本机，联网补传成功后会自动提交审核");
    } else {
      ElMessage.error((error as Error).message);
    }
  } finally {
    submitting.value = false;
  }
}

async function requestManualReview() {
  if (!uuid.value) return;
  submitting.value = true;
  try {
    const result = await api.post<{ status: string }>(`/spots/${uuid.value}/request-manual-review`);
    ElMessage.success("已转人工复核，审核员会尽快处理");
    spotStatus.value = result.status;
    void router.push({ name: "me" });
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    submitting.value = false;
  }
}

/** 当前编辑页对应的冲突被确认后，用服务端最新结果刷新表单 */
async function handleConflictResolved(event: Event) {
  const detail = (event as CustomEvent<{ clientId: string; spotUuid: string }>).detail;
  if (!detail || detail.clientId !== clientId.value) return;
  const resolvedUuid = uuid.value ?? detail.spotUuid;
  try {
    const spot = await api.get<Spot>(`/spots/${resolvedUuid}`);
    applySpot(spot);
    setTimeout(() => photoUploader.value?.clearLocalImages(), 0);
    await showPendingImages(clientId.value);
  } catch {
    // 刷新失败不影响已经入库的事实
  }
}

onMounted(async () => {
  await offline.hydrate();
  window.addEventListener("psdm:conflict-resolved", handleConflictResolved as EventListener);
  // 网络监听在 App.vue 全局注册一次即可，这里不重复挂载

  await catalog.load();

  // 新建条目时采用用户在设置里选定的默认模糊半径，
  // 否则"默认设置"这一项在界面上等于摆设。
  if (!isEdit.value && auth.user?.settings) {
    form.value.fuzzRadiusM = auth.user.settings.defaultFuzzRadius;
  }

  // 新建页也要有稳定的 clientId，离线添加的照片才能挂到草稿上
  if (!isEdit.value && !clientIdParam.value) {
    clientId.value = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  await loadExisting();
});

onBeforeUnmount(() => {
  window.removeEventListener("psdm:conflict-resolved", handleConflictResolved as EventListener);
  for (const url of localPreviewUrls.values()) URL.revokeObjectURL(url);
  localPreviewUrls.clear();
});
</script>

<template>
  <div class="page" v-loading="loading">
    <h1 class="page-title">
      {{ isEdit ? "编辑这条记录" : "记录一个公共空间细节" }}
    </h1>

    <el-alert
      v-if="!isOnline"
      type="warning"
      :closable="false"
      show-icon
      title="当前处于离线状态"
      description="填写的内容与照片会保存在本机，联网恢复后自动补传；若多端都改过同一内容，会请你确认合并结果。"
      style="margin-bottom: 16px"
    />
    <el-alert
      v-else-if="offline.pendingCount > 0"
      type="info"
      :closable="false"
      show-icon
      :title="`有 ${offline.pendingCount} 条内容等待补传`"
      style="margin-bottom: 16px"
    >
      <el-button size="small" :loading="offline.syncing" @click="offline.retryNow()">立即补传</el-button>
    </el-alert>
    <el-alert
      v-if="offline.conflictCount > 0"
      type="error"
      :closable="false"
      show-icon
      title="有内容与另一台设备冲突，等待确认"
      style="margin-bottom: 16px"
    />

    <el-alert
      v-if="reviewFeedback"
      type="warning"
      :closable="false"
      show-icon
      title="审核员给了修改建议"
      :description="reviewFeedback"
      style="margin-bottom: 16px"
    />

    <el-alert
      v-if="autoCheckIssues.length"
      type="error"
      :closable="false"
      show-icon
      title="提交前需要先处理这些内容"
      style="margin-bottom: 16px"
    >
      <ul style="margin: 6px 0 0; padding-left: 18px">
        <li v-for="issue in autoCheckIssues" :key="issue.code">{{ issue.message }}</li>
      </ul>
      <el-button v-if="canRequestManualReview" size="small" style="margin-top: 8px" @click="requestManualReview">
        我认为是误判，转人工复核
      </el-button>
    </el-alert>

    <el-card shadow="never">
      <el-form label-position="top">
        <el-form-item label="这是哪一类细节" required>
          <el-radio-group v-model="form.categoryCode">
            <el-radio-button v-for="item in catalog.categories" :key="item.code" :value="item.code">
              {{ item.name }}
            </el-radio-button>
          </el-radio-group>
          <p v-if="category?.description" class="muted" style="margin: 6px 0 0">{{ category.description }}</p>
        </el-form-item>

        <el-form-item label="一句话标题" required>
          <el-input v-model="form.title" maxlength="40" show-word-limit placeholder="例如：梧桐树下带靠背的长椅" />
        </el-form-item>

        <el-form-item label="补充描述">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            placeholder="什么时段适合来？有什么容易被忽略的细节？"
          />
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" style="margin-top: 12px">
      <template #header>
        <span>现场细节</span>
      </template>
      <AttributeForm v-model="form.attributes" :schema="schema" />
    </el-card>

    <el-card shadow="never" style="margin-top: 12px">
      <template #header>
        <span>位置</span>
      </template>

      <LocationPicker
        :lat="form.lat"
        :lng="form.lng"
        :fuzz-radius="form.fuzzRadiusM"
        :fuzz-enabled="form.fuzzEnabled"
        @update="onLocationUpdate"
      />

      <div style="margin-top: 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
        <el-switch v-model="form.fuzzEnabled" />
        <span>对外模糊显示位置</span>
        <el-select v-model="form.fuzzRadiusM" :disabled="!form.fuzzEnabled" style="width: 140px">
          <el-option label="20 米" :value="20" />
          <el-option label="50 米" :value="50" />
          <el-option label="100 米" :value="100" />
        </el-select>
      </div>
      <p class="muted" style="margin: 6px 0 0">
        模糊后别人只能看到大致范围，精确坐标仅你本人和审核员可见。这是为了保护贡献者。
      </p>
    </el-card>

    <el-card shadow="never" style="margin-top: 12px">
      <template #header>
        <span>照片（可选）</span>
      </template>
      <PhotoUploader
        ref="photoUploader"
        v-model="form.mediaUuids"
        :max="6"
        :offline="!isOnline"
        @local-files="onLocalFiles"
        @remove-local="onRemoveLocalImage"
      />
    </el-card>

    <div class="edit-actions">
      <el-button @click="router.back()">取消</el-button>
      <el-button :loading="saving" @click="onSaveDraft">
        {{ isOnline ? "保存草稿" : "保存到本机" }}
      </el-button>
      <el-button type="primary" :loading="submitting" @click="onSubmit">提交审核</el-button>
    </div>

    <p class="muted" style="margin-top: 8px">
      提交后会在 24 小时内出结果，结果会通过站内通知发给你，也可以在「我的记录」里查看状态。
      <template v-if="lastSavedAt">本机最近保存：{{ new Date(lastSavedAt).toLocaleString("zh-CN") }}</template>
    </p>
  </div>
</template>

<style scoped>
.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
