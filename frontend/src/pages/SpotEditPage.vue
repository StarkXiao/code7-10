<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api } from "@/api/client";
import type { AttributeSchema, Category, Spot } from "@/api/types";
import { useAuthStore } from "@/stores/auth";
import { useCatalogStore } from "@/stores/catalog";
import { useDraftStore, draftKeyFor, type DraftFormData } from "@/stores/drafts";
import { isOnline, onNetworkChange } from "@/offline/network";
import { conflictCache, lastSyncedCache, syncQueue } from "@/offline/queue";
import { getMedia, type LocalDraft } from "@/offline/db";
import type { FieldTimestamps, MergeFieldKey } from "@/offline/merge";
import { DEFAULT_CENTER } from "@/config/map";
import AttributeForm from "@/components/AttributeForm.vue";
import LocationPicker from "@/components/LocationPicker.vue";
import PhotoUploader from "@/components/PhotoUploader.vue";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const catalog = useCatalogStore();
const draftStore = useDraftStore();

const uuid = computed(() => (route.params.uuid ? String(route.params.uuid) : null));
const isEdit = computed(() => uuid.value !== null);

const form = reactive<DraftFormData>({
  categoryCode: "",
  title: "",
  description: "",
  attributes: {},
  lat: DEFAULT_CENTER[0],
  lng: DEFAULT_CENTER[1],
  fuzzEnabled: true,
  fuzzRadiusM: 50,
});
const mediaUuids = ref<string[]>([]);
const pendingLocalIds = ref<string[]>([]);

const loading = ref(false);
const saving = ref(false);
const submitting = ref(false);
const localSavedAt = ref<number | null>(null);
const spotStatus = ref<string>("draft");
const autoCheckIssues = ref<Array<{ code: string; message: string }>>([]);
const reviewFeedback = ref<string | null>(null);
const canRequestManualReview = ref(false);
const photoUploader = ref<InstanceType<typeof PhotoUploader> | null>(null);

const category = computed<Category | undefined>(() => catalog.byCode(form.categoryCode));
const schema = computed<AttributeSchema | null>(() => category.value?.schema ?? null);

// 这台设备上的本地草稿键：已存在条目直接用 uuid，新建条目首次保存时生成
const draftKey = ref<string>(uuid.value ?? draftKeyFor(null));
// 本轮编辑开始前的字段时间戳基线（从服务端载入时记录）
const baselineTimestamps = ref<FieldTimestamps>({});
const baseUpdatedAt = ref<string | null>(null);
const dirty = new Set<MergeFieldKey>();
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let stopNetworkWatch: (() => void) | null = null;

const hasLocalDraft = computed(
  () => draftStore.drafts.some((draft) => draft.key === draftKey.value) || localSavedAt.value !== null,
);

watch(
  () => form.fuzzEnabled,
  (enabled) => {
    if (!enabled) form.fuzzRadiusM = 0;
    else if (form.fuzzRadiusM === 0) form.fuzzRadiusM = 50;
    markDirty("fuzzEnabled");
    markDirty("fuzzRadiusM");
  },
);

function markDirty(field: MergeFieldKey): void {
  dirty.add(field);
  scheduleAutosave();
}

// 标量字段的具体标记在模板 @input/@change 里完成，
// attributes 与媒体列表在这里统一兜底。
watch(
  () => form.attributes,
  () => markDirty("attributes"),
  { deep: true },
);

watch(mediaUuids, () => {
  dirty.add("mediaUuids");
  scheduleAutosave();
});

function snapshotForm(): DraftFormData {
  return {
    categoryCode: form.categoryCode,
    title: form.title,
    description: form.description,
    attributes: { ...form.attributes },
    lat: form.lat,
    lng: form.lng,
    fuzzEnabled: form.fuzzEnabled,
    fuzzRadiusM: form.fuzzRadiusM,
  };
}

// 移动端随时可能被切后台/杀进程：停止操作 1.5 秒后自动落本地草稿，
// 不发网络请求，离线也能保住现场。
function scheduleAutosave(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    void persistLocal([...dirty]);
  }, 1500);
}

async function persistLocal(touched: MergeFieldKey[]): Promise<void> {
  if (!form.categoryCode && !form.title) return; // 空白表单不存
  const draft = await draftStore.save(
    draftKey.value,
    snapshotForm(),
    mediaUuids.value,
    touched,
    {
      spotUuid: uuid.value,
      baseUpdatedAt: baseUpdatedAt.value,
      baseline: baselineTimestamps.value,
    },
  );
  localSavedAt.value = draft.updatedAt;
  dirty.clear();
}

async function hydratePendingPhotos(draft: LocalDraft): Promise<void> {
  pendingLocalIds.value = draft.pendingPhotos.map((photo) => photo.localId);
  for (const photo of draft.pendingPhotos) {
    const record = await getMedia(photo.localId);
    if (record) {
      photoUploader.value?.addPendingPreview(photo.localId, record.blob, photo.name);
    }
  }
}

function fillFormFromSpot(spot: Spot): void {
  form.categoryCode = spot.category.code;
  form.title = spot.title;
  form.description = spot.description ?? "";
  form.attributes = { ...spot.attributes };
  form.lat = spot.location.lat;
  form.lng = spot.location.lng;
  form.fuzzEnabled = spot.location.fuzzed || spot.location.radiusMeters > 0;
  form.fuzzRadiusM = spot.location.radiusMeters || 50;
  mediaUuids.value = spot.media.map((asset) => asset.uuid);
  spotStatus.value = spot.status;
  baseUpdatedAt.value = spot.updatedAt;
}

async function loadExisting(): Promise<void> {
  if (!uuid.value) {
    form.categoryCode = catalog.categories[0]?.code ?? "";
    return;
  }

  loading.value = true;
  try {
    const spot = await api.get<Spot>(`/spots/${uuid.value}`);
    fillFormFromSpot(spot);

    // 进入编辑时把"各字段上一次修改时间"基线设为当前服务端版本，
    // 补传时据此判断远端字段是不是在我编辑期间被其他设备改过。
    const serverTime = Date.parse(spot.updatedAt) || Date.now();
    const base: FieldTimestamps = {};
    for (const field of [
      "categoryCode",
      "title",
      "description",
      "attributes",
      "lat",
      "lng",
      "fuzzEnabled",
      "fuzzRadiusM",
      "mediaUuids",
    ] as MergeFieldKey[]) {
      base[field] = serverTime;
    }
    baselineTimestamps.value = base;

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
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

// 新建条目：优先恢复指定（来自「我的记录」）或最近未完成的本地草稿
async function restoreNewDraft(): Promise<void> {
  const wantedKey = typeof route.query.draft === "string" ? route.query.draft : null;
  const local = wantedKey
    ? draftStore.drafts.find((draft) => draft.key === wantedKey)
    : draftStore.drafts
        .filter((draft) => draft.key.startsWith("new:"))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  if (!local) return;

  try {
    await ElMessage.success({ message: "已恢复上次未提交的本地草稿", duration: 2000 });
    draftKey.value = local.key;
    Object.assign(form, draftStore.toFormData(local));
    mediaUuids.value = [...local.mediaUuids];
    localSavedAt.value = local.updatedAt;
    await hydratePendingPhotos(local);
  } catch {
    // 预览失败不影响表单内容
  }
}

function validateBeforeSubmit(): string | null {
  if (!form.categoryCode) return "请选择分类";
  if (form.title.trim().length < 2) return "请填写标题（至少 2 个字）";

  const required = schema.value?.required ?? [];
  for (const key of required) {
    const value = form.attributes[key];
    if (value === undefined || value === null || value === "") {
      return `请填写「${schema.value?.properties[key]?.label ?? key}」`;
    }
  }
  if (pendingLocalIds.value.length > 0) {
    return "还有照片没有上传完成，联网补传后再提交";
  }
  return null;
}

function onLocationUpdate(payload: { lat: number; lng: number }): void {
  form.lat = payload.lat;
  form.lng = payload.lng;
  markDirty("lat");
  markDirty("lng");
}

async function onPendingFile(payload: { file: File }): Promise<void> {
  const { photo } = await draftStore.addPendingPhoto(draftKey.value, payload.file);
  photoUploader.value?.addPendingPreview(photo.localId, payload.file, payload.file.name);
  pendingLocalIds.value = [...pendingLocalIds.value, photo.localId];
  dirty.add("mediaUuids");
  await persistLocal(["mediaUuids"]);
}

async function onRemovePending(localId: string): Promise<void> {
  await draftStore.removePendingPhoto(draftKey.value, localId);
}

// 保存草稿：离线只入本地队列；在线优先即时保存到服务端（后台仍有本地副本兜底）
async function onSaveDraft(): Promise<void> {
  saving.value = true;
  try {
    await persistLocal(ALL_TOUCHED());

    if (!isOnline.value) {
      ElMessage.success("草稿已保存在本机，联网后自动补传");
      return;
    }

    const outcome = await syncQueue.syncOne(draftKey.value);
    if (outcome?.status === "synced" && outcome.spotUuid) {
      ElMessage.success("草稿已保存");
      localSavedAt.value = null;
      if (!isEdit.value) {
        void router.replace({ name: "spot-edit", params: { uuid: outcome.spotUuid } });
      }
    } else if (outcome?.status === "conflict") {
      // 弹窗由全局 ConflictResolver 响应冲突事件自动弹出
    } else if (outcome?.status === "error") {
      ElMessage.warning(`${outcome.message ?? "暂未同步"}，已保存在本机，稍后自动重试`);
    }
  } finally {
    saving.value = false;
  }
}

function ALL_TOUCHED(): MergeFieldKey[] {
  // 手动保存时把表单字段都视作已触碰，保证本地时间戳完整
  return ["categoryCode", "title", "description", "attributes", "lat", "lng", "fuzzEnabled", "fuzzRadiusM", "mediaUuids"];
}

// 提交审核：内容先保存成功，再调 submit；离线时入队并明确告知用户
async function onSubmit(): Promise<void> {
  const error = validateBeforeSubmit();
  if (error) {
    ElMessage.warning(error);
    return;
  }

  await persistLocal(ALL_TOUCHED());

  if (!isOnline.value) {
    ElMessage.info("当前离线：草稿已存在本机，联网补传成功后请再点一次「提交审核」");
    return;
  }

  submitting.value = true;
  try {
    const outcome = await syncQueue.syncOne(draftKey.value);
    if (outcome?.status !== "synced" || !outcome.spotUuid) {
      if (outcome?.status === "error") {
        ElMessage.warning(`${outcome.message ?? "同步未完成"}，草稿已保存在本机`);
      }
      return;
    }

    const id = outcome.spotUuid;
    if (!isEdit.value) {
      void router.replace({ name: "spot-edit", params: { uuid: id } });
    }

    const result = await api.post<{
      status: string;
      autoCheck: { passed: boolean; issues: Array<{ code: string; message: string }> };
      canRequestManualReview: boolean;
    }>(`/spots/${id}/submit`);

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
    ElMessage.error((error as Error).message);
  } finally {
    submitting.value = false;
  }
}

async function requestManualReview(): Promise<void> {
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

// 补传成功后：若用户还停在这条草稿的编辑页，接上服务端版本
const stopOutcomeWatch = syncQueue.onOutcome(async (outcome) => {
  if (outcome.key !== draftKey.value) return;

  if (outcome.status === "synced" && outcome.spotUuid) {
    const synced = lastSyncedCache.get(outcome.key);
    if (synced) baseUpdatedAt.value = synced.updatedAt;
    localSavedAt.value = null;
    if (!isEdit.value) {
      draftKey.value = outcome.spotUuid;
      void router.replace({ name: "spot-edit", params: { uuid: outcome.spotUuid } });
    }
  }

  if (outcome.status === "conflict" && conflictCache.has(outcome.key)) {
    // 全局弹窗处理；本地草稿状态由队列维护
    await draftStore.refresh();
  }
});

onMounted(async () => {
  await catalog.load();
  await draftStore.refresh();

  // 新建条目时采用用户在设置里选定的默认模糊半径
  if (!isEdit.value && auth.user?.settings) {
    form.fuzzRadiusM = auth.user.settings.defaultFuzzRadius;
  }

  if (isEdit.value) {
    await loadExisting();
    // 服务端拉不到（纯离线打开已存在条目）时，退而用本地草稿
    if (!baseUpdatedAt.value) {
      const local = await draftStore.get(draftKey.value);
      if (local) {
        Object.assign(form, draftStore.toFormData(local));
        mediaUuids.value = [...local.mediaUuids];
        await hydratePendingPhotos(local);
        ElMessage.info("当前离线，正在编辑本机保存的草稿");
      }
    } else {
      const local = await draftStore.get(draftKey.value);
      if (local) await hydratePendingPhotos(local);
    }
  } else {
    await restoreNewDraft();
  }

  stopNetworkWatch = onNetworkChange((online) => {
    if (online) ElMessage.success("网络已恢复，正在补传本地草稿");
  });
});

onBeforeUnmount(() => {
  stopOutcomeWatch();
  stopNetworkWatch?.();
  if (autosaveTimer) clearTimeout(autosaveTimer);
  // 离开页面时把最新状态落一次盘，防止最后几笔输入丢失
  void persistLocal([...dirty]).catch(() => undefined);
});
</script>

<template>
  <div class="page" v-loading="loading">
    <h1 class="page-title">
      {{ isEdit ? "编辑这条记录" : "记录一个公共空间细节" }}
    </h1>

    <el-alert
      v-if="!isOnline"
      type="info"
      :closable="false"
      show-icon
      title="当前处于离线状态"
      description="编辑内容和照片会暂存在这台设备上，网络恢复后自动补传；多端修改的冲突会在补传时请你确认。"
      style="margin-bottom: 16px"
    />
    <el-alert
      v-else-if="localSavedAt"
      type="success"
      :closable="false"
      show-icon
      :title="`本机草稿已保存（${new Date(localSavedAt).toLocaleTimeString('zh-CN')}），正在后台同步`"
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
          <el-radio-group v-model="form.categoryCode" @change="markDirty('categoryCode')">
            <el-radio-button v-for="item in catalog.categories" :key="item.code" :value="item.code">
              {{ item.name }}
            </el-radio-button>
          </el-radio-group>
          <p v-if="category?.description" class="muted" style="margin: 6px 0 0">{{ category.description }}</p>
        </el-form-item>

        <el-form-item label="一句话标题" required>
          <el-input
            v-model="form.title"
            maxlength="40"
            show-word-limit
            placeholder="例如：梧桐树下带靠背的长椅"
            @input="markDirty('title')"
          />
        </el-form-item>

        <el-form-item label="补充描述">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            placeholder="什么时段适合来？有什么容易被忽略的细节？"
            @input="markDirty('description')"
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
        <el-switch
          :model-value="form.fuzzEnabled"
          @update:model-value="(value: boolean) => { form.fuzzEnabled = value; markDirty('fuzzEnabled'); }"
        />
        <span>对外模糊显示位置</span>
        <el-select
          :model-value="form.fuzzRadiusM"
          :disabled="!form.fuzzEnabled"
          style="width: 140px"
          @update:model-value="(value: number) => { form.fuzzRadiusM = value; markDirty('fuzzRadiusM'); }"
        >
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
        v-model="mediaUuids"
        v-model:pending-local-ids="pendingLocalIds"
        :max="6"
        @pending-file="onPendingFile"
        @remove-pending="onRemovePending"
      />
    </el-card>

    <div class="edit-actions">
      <el-button @click="router.back()">取消</el-button>
      <el-button :loading="saving" @click="onSaveDraft">
        {{ isOnline ? "保存草稿" : "保存到本机" }}
      </el-button>
      <el-button type="primary" :loading="submitting" @click="onSubmit">
        {{ isOnline ? "提交审核" : "离线暂存" }}
      </el-button>
    </div>

    <p class="muted" style="margin-top: 8px">
      提交后会在 24 小时内出审结果，结果会通过站内通知发给你，也可以在「我的记录」里查看状态。
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
