<script setup lang="ts">// 顶部离线/待同步状态条。
// 在线且没有待处理内容时不占位；离线时吸顶提示，点击可在有网时立即触发补传。
import { computed } from "vue";
import { ElMessage } from "element-plus";
import { isOnline } from "@/offline/network";
import { useDraftStore } from "@/stores/drafts";
import { syncQueue } from "@/offline/queue";

const draftStore = useDraftStore();

const pending = computed(() => draftStore.drafts.filter((d) => d.status !== "conflict"));
const conflicts = computed(() => draftStore.drafts.filter((d) => d.status === "conflict"));
const show = computed(() => !isOnline.value || pending.value.length > 0 || conflicts.value.length > 0);

function retryNow() {
  if (!isOnline.value) {
    ElMessage.info("仍然离线，网络恢复后会自动补传");
    return;
  }
  syncQueue.kick();
  ElMessage.success("正在补传本地草稿");
}
</script>

<template>
  <div v-if="show" class="offline-bar" :class="{ 'offline-bar--offline': !isOnline }" role="status">
    <template v-if="!isOnline">
      <el-icon><Bottom /></el-icon>
      <span>离线中：编辑会自动保存在本机，联网后补传</span>
    </template>
    <template v-else-if="conflicts.length > 0">
      <el-icon><Warning /></el-icon>
      <span>有 {{ conflicts.length }} 条草稿与其他设备的修改冲突，需要你确认最终结果</span>
    </template>
    <template v-else>
      <el-icon><Loading /></el-icon>
      <span>网络已恢复，正在补传 {{ pending.length }} 条本地草稿…</span>
      <el-button link type="primary" @click="retryNow">立即重试</el-button>
    </template>
  </div>
</template>

<style scoped>
.offline-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  font-size: 13px;
  background: var(--color-primary);
  color: #fff;
}

.offline-bar--offline {
  background: var(--color-text-soft, #909399);
}

@media (max-width: 560px) {
  .offline-bar {
    font-size: 12px;
    padding: 6px 10px;
  }
}
</style>
