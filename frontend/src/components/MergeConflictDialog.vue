<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useOfflineStore } from "@/offline/store";
import { useCatalogStore } from "@/stores/catalog";
import { fieldLabel, formatFieldValue } from "@/offline/merge";

const offline = useOfflineStore();
const catalog = useCatalogStore();

const emit = defineEmits<{
  (event: "resolved"): void;
}>();

const visible = computed({
  get: () => offline.pendingConflict !== null,
  // 对话框没有"静默关闭"：点 X / 稍后处理都走 cancel()，保证 outbox 的 conflict 状态有统一出口
  set: () => undefined,
});

/** 属性 key -> 中文标签（来自分类 Schema） */
const attributeLabels = computed<Record<string, string>>(() => {
  const labels: Record<string, string> = {};
  for (const category of catalog.categories) {
    for (const [key, prop] of Object.entries(category.schema?.properties ?? {})) {
      if (prop.label) labels[key] = prop.label;
    }
  }
  return labels;
});

/** 用户对每个冲突字段的最终选择；默认取时间戳较新的一方 */
const choices = ref<Record<string, "server" | "client">>({});
const submitting = ref(false);

watch(
  () => offline.pendingConflict,
  (conflict) => {
    choices.value = {};
    if (conflict) {
      for (const item of conflict.proposal.conflicts) {
        choices.value[item.field] = item.winner;
      }
    }
  },
  { immediate: true },
);

const proposal = computed(() => offline.pendingConflict?.proposal);
const conflicts = computed(() => proposal.value?.conflicts ?? []);
/** 无冲突但 409 也可能携带自动合并字段（只有一端改动），确认时一并入库 */
const autoMergedFields = computed(() => {
  const conflictKeys = new Set(conflicts.value.map((item) => item.field));
  return Object.fromEntries(
    Object.entries(proposal.value?.merged ?? {}).filter(([key]) => !conflictKeys.has(key)),
  );
});

function labelFor(field: string): string {
  if (field.startsWith("attributes.")) {
    const key = field.slice("attributes.".length);
    return attributeLabels.value[key] ?? fieldLabel(field);
  }
  return fieldLabel(field);
}

function timeText(value: string | null): string {
  if (!value) return "未知时间";
  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return value;
  }
}

function buildFinalFields(): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...autoMergedFields.value };
  for (const conflict of conflicts.value) {
    const choice = choices.value[conflict.field] ?? conflict.winner;
    fields[conflict.field] = choice === "server" ? conflict.server : conflict.client;
  }
  return fields;
}

function buildFinalTimestamps(fields: Record<string, unknown>): Record<string, string> {
  const confirmedAt = new Date().toISOString();
  const timestamps: Record<string, string> = {};
  for (const field of Object.keys(fields)) {
    // 用户确认即最新真相；保留原较新时间戳仅用于展示，入库以确认时刻为准
    timestamps[field] = confirmedAt;
  }
  return timestamps;
}

async function confirm() {
  const conflict = offline.pendingConflict;
  if (!conflict) return;
  submitting.value = true;
  try {
    const fields = buildFinalFields();
    const timestamps = buildFinalTimestamps(fields);
    const ok = await offline.resolveConflict(
      conflict.clientId,
      fields,
      timestamps,
      conflict.serverUpdatedAt,
    );
    if (ok) {
      ElMessage.success(conflict.intent === "submit" ? "合并完成，已提交审核" : "合并结果已保存");
      // 通知正在编辑该条目的页面用最新结果刷新表单
      window.dispatchEvent(
        new CustomEvent("psdm:conflict-resolved", {
          detail: { clientId: conflict.clientId, spotUuid: conflict.spotUuid, intent: conflict.intent },
        }),
      );
      emit("resolved");
    } else if (offline.pendingConflict) {
      ElMessage.warning("确认期间内容又发生了变化，请基于最新内容再确认一次");
    }
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    submitting.value = false;
  }
}

function cancel() {
  offline.dismissConflict();
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="这条记录在另一台设备上修改过"
    width="92%"
    style="max-width: 640px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="true"
    align-center
    @close="cancel"
  >
    <p class="muted" style="margin-top: 0">
      系统已按修改时间自动合并了不冲突的内容。下面{{ conflicts.length }}处两端都做了修改，
      请逐项确认最终保留哪一份；确认后才会入库。
    </p>

    <el-alert
      v-if="conflicts.length === 0"
      type="success"
      :closable="false"
      show-icon
      title="没有真正冲突的字段，所有改动已自动合并，确认即可保存"
      style="margin-bottom: 12px"
    />

    <div class="conflict-list">
      <div v-for="conflict in conflicts" :key="conflict.field" class="conflict-item">
        <div class="conflict-item__label">{{ labelFor(conflict.field) }}</div>
        <el-radio-group v-model="choices[conflict.field]" class="conflict-item__choices">
          <el-radio value="server" :class="{ 'is-winner': conflict.winner === 'server' }">
            <div class="choice">
              <span class="choice__title">
                另一台设备{{ conflict.winner === "server" ? "（时间较新）" : "" }}
              </span>
              <span class="choice__time">{{ timeText(conflict.serverUpdatedAt) }}</span>
              <span class="choice__value">{{ formatFieldValue(conflict.field, conflict.server) }}</span>
            </div>
          </el-radio>
          <el-radio value="client" :class="{ 'is-winner': conflict.winner === 'client' }">
            <div class="choice">
              <span class="choice__title">
                本机{{ conflict.winner === "client" ? "（时间较新）" : "" }}
              </span>
              <span class="choice__time">{{ timeText(conflict.clientUpdatedAt) }}</span>
              <span class="choice__value">{{ formatFieldValue(conflict.field, conflict.client) }}</span>
            </div>
          </el-radio>
        </el-radio-group>
      </div>
    </div>

    <template #footer>
      <el-button @click="cancel">稍后处理</el-button>
      <el-button type="primary" :loading="submitting" @click="confirm">
        确认合并结果并保存
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 56vh;
  overflow-y: auto;
}

.conflict-item {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 12px;
}

.conflict-item__label {
  font-weight: 600;
  margin-bottom: 8px;
}

.conflict-item__choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.choice {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.choice__title {
  font-weight: 500;
}

.choice__time {
  font-size: 12px;
  color: var(--color-text-soft);
}

.choice__value {
  font-size: 13px;
  word-break: break-all;
}
</style>
