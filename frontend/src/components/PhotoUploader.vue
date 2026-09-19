<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { api, ApiError, mediaUrl } from "@/api/client";
import { isOnline } from "@/offline/network";
import type { MediaStatus, UploadedAsset } from "@/api/types";

const props = withDefaults(
  defineProps<{
    modelValue: string[];
    max?: number;
    /** 断网期间选取、待联网补传的图片 */
    pendingLocalIds?: string[];
    disabled?: boolean;
  }>(),
  { max: 6, pendingLocalIds: () => [], disabled: false },
);

const emit = defineEmits<{
  (event: "update:modelValue", value: string[]): void;
  (event: "update:pendingLocalIds", value: string[]): void;
  /** 用户选了文件；在线由组件自行上传，离线交给父组件存入 IndexedDB */
  (event: "pending-file", payload: { file: File }): void;
  (event: "remove-pending", localId: string): void;
}>();

interface TrackedAsset extends UploadedAsset {
  variantVersion: number;
  statusText: string;
  previewUrl: string;
}

const assets = ref<TrackedAsset[]>([]);
const pendingPreview = ref<Array<{ localId: string; url: string; name: string }>>([]);
const uploading = ref(false);
const polling = new Set<string>();
let pollTimer: number | undefined;
const objectUrls: string[] = [];

const limit = computed(() => props.max);
const usedCount = computed(() => assets.value.length + pendingPreview.value.length);
const canAdd = computed(() => usedCount.value < limit.value);

// 隐私状态直接展示给贡献者，让他知道图片还要过一道隐私处理
const STATUS_TEXT: Record<string, string> = {
  processing: "隐私处理中…",
  auto_clean: "未发现敏感区域，待审核确认",
  auto_blurred: "已自动模糊，待审核确认",
  needs_manual: "需要人工确认隐私区域",
  manual_blurred: "已人工模糊，待确认",
  confirmed: "隐私处理已确认",
  failed: "处理失败，请重新上传",
};

function syncModel() {
  emit(
    "update:modelValue",
    assets.value.map((asset) => asset.uuid),
  );
}

async function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length === 0) return;

  const room = limit.value - usedCount.value;
  if (room <= 0) {
    ElMessage.warning(`最多上传 ${limit.value} 张图片`);
    return;
  }
  const picked = files.slice(0, room);

  if (!isOnline.value) {
    // 离线：只把文件交给父组件入 IndexedDB，预览由父组件回填 localId 后生成
    for (const file of picked) emit("pending-file", { file });
    return;
  }

  const formData = new FormData();
  for (const file of picked) {
    formData.append("files", file);
  }

  uploading.value = true;
  try {
    const result = await api.upload<{ assets: UploadedAsset[]; failures: Array<{ name: string; message: string }> }>(
      "/uploads/images",
      formData,
    );

    for (const asset of result.assets) {
      assets.value.push({
        ...asset,
        variantVersion: 0,
        statusText: STATUS_TEXT[asset.privacyStatus] ?? asset.privacyStatus,
        previewUrl: mediaUrl(asset.variants.grid ?? asset.variants.thumb),
      });
      startPolling(asset.uuid);
    }

    for (const failure of result.failures) {
      ElMessage.error(`${failure.name}：${failure.message}`);
    }

    syncModel();
  } catch (error) {
    // 请求级失败基本就是断网/弱网：降级成本地暂存，不让用户白选一遍
    if (!isOnline.value || !(error instanceof ApiError)) {
      for (const file of picked) emit("pending-file", { file });
      ElMessage.info("当前网络不可用，照片已暂存在本机，联网后自动补传");
    } else {
      ElMessage.error(error.message);
    }
  } finally {
    uploading.value = false;
  }
}

// 上传接口立即返回，真正的模糊化在后台完成，因此这里轮询状态
function startPolling(uuid: string) {
  if (polling.has(uuid)) return;
  polling.add(uuid);

  if (pollTimer === undefined) {
    pollTimer = window.setInterval(refreshStatuses, 2500);
  }
}

async function refreshStatuses() {
  const pending = assets.value.filter((asset) => asset.privacyStatus === "processing");

  if (pending.length === 0) {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
    polling.clear();
    return;
  }

  await Promise.all(
    pending.map(async (asset) => {
      try {
        const status = await api.get<MediaStatus>(`/media/${asset.uuid}/status`);
        const target = assets.value.find((item) => item.uuid === asset.uuid);
        if (!target) return;
        target.privacyStatus = status.privacyStatus;
        target.variantVersion = status.variantVersion;
        target.statusText = STATUS_TEXT[status.privacyStatus] ?? status.privacyStatus;
        target.previewUrl = mediaUrl(status.variants.grid ?? status.variants.thumb);
      } catch {
        // 单张状态查询失败不打断整体轮询
      }
    }),
  );
}

function remove(uuid: string) {
  assets.value = assets.value.filter((asset) => asset.uuid !== uuid);
  syncModel();
}

function removePending(localId: string) {
  const target = pendingPreview.value.find((item) => item.localId === localId);
  if (target) URL.revokeObjectURL(target.url);
  pendingPreview.value = pendingPreview.value.filter((item) => item.localId !== localId);
  emit(
    "update:pendingLocalIds",
    pendingPreview.value.map((item) => item.localId),
  );
  emit("remove-pending", localId);
}

// 父组件（离线暂存完成）回填一张待传图片的预览
function addPendingPreview(localId: string, blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  pendingPreview.value = [...pendingPreview.value, { localId, url, name }];
  emit(
    "update:pendingLocalIds",
    pendingPreview.value.map((item) => item.localId),
  );
}

defineExpose({
  setExisting(next: Array<{ uuid: string; variants: Record<string, string>; privacyStatus: string; variantVersion: number; width: number; height: number }>) {
    assets.value = next.map((item) => ({
      uuid: item.uuid,
      duplicated: false,
      privacyStatus: item.privacyStatus,
      width: item.width,
      height: item.height,
      variants: item.variants,
      variantVersion: item.variantVersion,
      statusText: STATUS_TEXT[item.privacyStatus] ?? item.privacyStatus,
      previewUrl: mediaUrl(item.variants.grid ?? item.variants.thumb),
    }));
    syncModel();
  },
  addPendingPreview,
});

// pendingLocalIds 由父组件完整控制时，清理失效的预览
watch(
  () => props.pendingLocalIds,
  (ids) => {
    for (const item of pendingPreview.value) {
      if (!ids.includes(item.localId)) {
        URL.revokeObjectURL(item.url);
      }
    }
    pendingPreview.value = pendingPreview.value.filter((item) => ids.includes(item.localId));
  },
);

onBeforeUnmount(() => {
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
  for (const url of objectUrls) URL.revokeObjectURL(url);
});
</script>

<template>
  <div class="photo-uploader">
    <div class="photo-grid">
      <div v-for="asset in assets" :key="asset.uuid" class="photo-thumb">
        <img :src="asset.previewUrl" :alt="`已上传图片 ${asset.uuid.slice(0, 8)}`" />
        <el-button
          class="photo-thumb__remove"
          size="small"
          circle
          type="danger"
          aria-label="移除这张图片"
          @click="remove(asset.uuid)"
        >
          <el-icon><Close /></el-icon>
        </el-button>
        <span class="photo-thumb__status">{{ asset.statusText }}</span>
      </div>

      <div v-for="item in pendingPreview" :key="item.localId" class="photo-thumb photo-thumb--pending">
        <img :src="item.url" :alt="`待上传图片 ${item.name}`" />
        <el-button
          class="photo-thumb__remove"
          size="small"
          circle
          type="warning"
          aria-label="移除这张待传图片"
          @click="removePending(item.localId)"
        >
          <el-icon><Close /></el-icon>
        </el-button>
        <span class="photo-thumb__status">待联网补传</span>
      </div>

      <label v-if="canAdd && !disabled" class="photo-add">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/tiff,image/avif"
          multiple
          :disabled="uploading"
          @change="handleFiles"
        />
        <el-icon v-if="!uploading"><Plus /></el-icon>
        <span>{{ uploading ? "上传中…" : "添加照片" }}</span>
      </label>
    </div>

    <p class="muted" style="margin: 8px 0 0">
      最多 {{ limit }} 张。上传时会自动清除照片里的位置等元数据；断网时选的照片会暂存在本机，联网后自动补传。
    </p>
  </div>
</template>

<style scoped>
.photo-thumb--pending {
  outline: 2px dashed var(--color-warning, #e6a23c);
  outline-offset: -2px;
}

.photo-add {
  width: 104px;
  height: 104px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--color-text-soft);
  font-size: 12px;
  cursor: pointer;
  background: var(--color-bg);
}

.photo-add:hover {
  border-color: var(--color-primary);
  color: var(--color-primary-dark);
}

.photo-add input {
  display: none;
}
</style>
