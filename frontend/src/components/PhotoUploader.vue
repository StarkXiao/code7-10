<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { ElMessage } from "element-plus";
import { api, mediaUrl } from "@/api/client";
import type { MediaStatus, UploadedAsset } from "@/api/types";

const props = defineProps<{
  modelValue: string[];
  max?: number;
  /** 离线模式：照片不直接上传，交父组件存入 IndexedDB，联网后补传 */
  offline?: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: string[]): void;
  (event: "local-files", files: File[]): void;
  (event: "remove-local", localId: string): void;
}>();

interface TrackedAsset extends UploadedAsset {
  variantVersion: number;
  statusText: string;
  previewUrl: string;
}

interface LocalImage {
  localId: string;
  previewUrl: string;
  filename: string;
  mediaUuid: string | null;
  lastError: string | null;
}

const assets = ref<TrackedAsset[]>([]);
const localImages = ref<LocalImage[]>([]);
const uploading = ref(false);
const polling = new Set<string>();
let pollTimer: number | undefined;

const limit = computed(() => props.max ?? 6);
const totalCount = computed(() => assets.value.length + localImages.value.length);
const canAdd = computed(() => totalCount.value < limit.value);

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
  // 合并服务端图片 UUID 与本机待补传图片 ID：
  // v-model 是唯一数据源，服务端图片与本机图片都要出现在里面。
  // 去重，避免 setExisting/addLocalImage 的调用顺序导致同一引用重复
  const next = [
    ...assets.value.map((asset) => asset.uuid),
    ...localImages.value.map((image) => image.localId),
  ];
  const unique = [...new Set(next)];
  emit("update:modelValue", unique);
}

async function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length === 0) return;

  const room = limit.value - totalCount.value;
  if (room <= 0) {
    ElMessage.warning(`最多上传 ${limit.value} 张图片`);
    return;
  }
  const picked = files.slice(0, room);

  // 离线：文件交给父组件持久化（IndexedDB），本组件只负责预览
  if (props.offline) {
    emit("local-files", picked);
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
    // 网络失败时不要丢掉用户刚拍的照片：转为离线暂存，联网后补传
    if (error instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test((error as Error).message)) {
      ElMessage.warning("当前网络不可用，照片已改为本机暂存，联网后自动上传");
      emit("local-files", picked);
    } else {
      ElMessage.error((error as Error).message);
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

function removeLocal(localId: string) {
  localImages.value = localImages.value.filter((image) => image.localId !== localId);
  // 先从视图移除并同步 v-model，再通知父组件清理 IndexedDB
  syncModel();
  emit("remove-local", localId);
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
  addLocalImage(image: LocalImage) {
    if (localImages.value.some((item) => item.localId === image.localId)) return;
    localImages.value.push(image);
    syncModel();
  },
  clearLocalImages() {
    localImages.value = [];
  },
});

onBeforeUnmount(() => {
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
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

      <div v-for="image in localImages" :key="image.localId" class="photo-thumb photo-thumb--local">
        <img :src="image.previewUrl" :alt="`本机待补传图片 ${image.filename}`" />
        <el-button
          class="photo-thumb__remove"
          size="small"
          circle
          type="danger"
          aria-label="移除这张待补传图片"
          @click="removeLocal(image.localId)"
        >
          <el-icon><Close /></el-icon>
        </el-button>
        <span class="photo-thumb__status photo-thumb__status--pending">
          {{ image.mediaUuid ? "已上传，待同步条目" : "本机暂存，联网后补传" }}
        </span>
      </div>

      <label v-if="canAdd" class="photo-add">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/tiff,image/avif"
          multiple
          :disabled="uploading"
          @change="handleFiles"
        />
        <el-icon v-if="!uploading"><Plus /></el-icon>
        <span>{{ uploading ? "上传中…" : offline ? "拍照/选图（暂存本机）" : "添加照片" }}</span>
      </label>
    </div>

    <p class="muted" style="margin: 8px 0 0">
      最多 {{ limit }} 张。上传时会自动清除照片里的位置等元数据，人脸、车牌等区域由审核员确认后打码。
      离线时照片暂存在本机，联网恢复后自动补传。
    </p>
  </div>
</template>

<style scoped>
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

.photo-thumb--local {
  outline: 2px dashed var(--el-color-warning);
  outline-offset: -2px;
}

.photo-thumb__status--pending {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}
</style>
