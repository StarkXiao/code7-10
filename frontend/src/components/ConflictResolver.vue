<script setup lang="ts">
// 多端内容冲突的确认弹窗。
//
// 同步队列在 PATCH 撞到 409 时把冲突放进 conflictCache 并广播事件，
// 这个组件挂在 App 根部，收到事件就弹出。默认选中字段级时间戳合并的建议值，
// 用户可以逐字段改选"本机/其他设备"，并在提交前直接编辑文本字段。
// 只有用户点"确认入库"后才会发 PATCH——任何自动合并都不直接落库。

import { reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { conflictCache, syncQueue, type ConflictContext } from "@/offline/queue";
import type { MergeFieldKey, SpotDraftPayload } from "@/offline/merge";
import { useCatalogStore } from "@/stores/catalog";
import { useDraftStore } from "@/stores/drafts";

const FIELD_LABELS: Record<MergeFieldKey, string> = {
  categoryCode: "分类",
  title: "标题",
  description: "描述",
  attributes: "现场细节",
  lat: "纬度",
  lng: "经度",
  fuzzEnabled: "模糊位置",
  fuzzRadiusM: "模糊半径",
  mediaUuids: "照片",
};

const visible = ref(false);
const saving = ref(false);
const activeKey = ref<string | null>(null);
const context = ref<ConflictContext | null>(null);
const catalog = useCatalogStore();
const draftStore = useDraftStore();

// 每个冲突字段当前选用的一方
const chosenSide = reactive<Record<string, "local" | "remote">>({});
// 用户在弹窗里直接修改后的最终内容
const finalPayload = ref<SpotDraftPayload>({});

interface Row {
  field: MergeFieldKey;
  label: string;
  suggested: "local" | "remote";
}

const rows = ref<Row[]>([]);

function pickFromCache(key: string): boolean {
  const found = conflictCache.get(key);
  if (!found) return false;
  context.value = found;
  activeKey.value = key;

  const { proposal } = found;
  finalPayload.value = { ...proposal.merged };

  // 重新算一遍冲突字段（合并模块是纯函数，这里复用它的判定思路：
  // 建议值与本地不同就默认选远端，否则选本地）。
  rows.value = (Object.keys(FIELD_LABELS) as MergeFieldKey[])
    .filter((field) => field in proposal.local || field in proposal.remote)
    .filter((field) => JSON.stringify(proposal.local[field]) !== JSON.stringify(proposal.remote[field]))
    .map((field) => ({
      field,
      label: FIELD_LABELS[field],
      suggested:
        JSON.stringify(proposal.merged[field]) === JSON.stringify(proposal.local[field]) ? "local" : "remote",
    }));

  for (const row of rows.value) chosenSide[row.field] = row.suggested;
  visible.value = true;
  return true;
}

// 冲突可能在任意页面发生，队列事件只带 key，内容从缓存取
syncQueue.onOutcome((outcome) => {
  if (outcome.status === "conflict" && !visible.value) {
    pickFromCache(outcome.key);
  }
});

function choose(field: MergeFieldKey, side: "local" | "remote"): void {
  chosenSide[field] = side;
  if (!context.value) return;
  const source = side === "local" ? context.value.proposal.local : context.value.proposal.remote;
  finalPayload.value = { ...finalPayload.value, [field]: source[field] };
}

function categoryName(code: unknown): string {
  if (typeof code !== "string") return String(code ?? "");
  return catalog.byCode(code)?.name ?? code;
}

function formatValue(field: MergeFieldKey, side: "local" | "remote"): string {
  if (!context.value) return "";
  const value = context.value.proposal[side][field];

  if (field === "categoryCode") return categoryName(value);
  if (field === "fuzzEnabled") return value ? "开启模糊" : "显示精确位置";
  if (field === "fuzzRadiusM") return `${value ?? 0} 米`;
  if (field === "lat") return Number(value).toFixed(6);
  if (field === "lng") return Number(value).toFixed(6);
  if (field === "mediaUuids") return `${Array.isArray(value) ? value.length : 0} 张照片`;
  if (field === "attributes") {
    if (!value || typeof value !== "object") return "（空）";
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "（空）";
    return entries
      .map(([key, val]) => {
        const prop = catalog.byCode(String(context.value?.proposal[side].categoryCode ?? ""))?.schema.properties[key];
        const label = prop?.label ?? key;
        return `${label}: ${Array.isArray(val) ? val.join("、") : String(val)}`;
      })
      .join("；");
  }
  return String(value ?? "（空）");
}

const editableTextFields = new Set<MergeFieldKey>(["title", "description"]);

async function confirm(): Promise<void> {
  if (!activeKey.value) return;
  saving.value = true;
  try {
    const outcome = await syncQueue.resolveConflict(activeKey.value, finalPayload.value);
    if (outcome.status === "synced") {
      ElMessage.success("已按你确认的内容合并入库");
      visible.value = false;
      activeKey.value = null;
      context.value = null;
      await draftStore.refresh();
    } else {
      ElMessage.error(outcome.message ?? "保存失败，请重试");
    }
  } finally {
    saving.value = false;
  }
}

async function discard(): Promise<void> {
  if (!activeKey.value) return;
  await draftStore.remove(activeKey.value);
  ElMessage.info("已放弃本机草稿，保留服务端版本");
  visible.value = false;
  activeKey.value = null;
  context.value = null;
}

function close(): void {
  // 直接关闭不处理：草稿保持 conflict 状态，下次同步或在"我的记录"里仍可处理
  visible.value = false;
}

function remoteTimeText(): string {
  if (!context.value) return "";
  return new Date(context.value.serverSpot.updatedAt).toLocaleString("zh-CN");
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="多端内容冲突，请确认最终结果"
    width="560px"
    :close-on-click-modal="false"
    append-to-body
    @close="close"
  >
    <el-alert
      type="warning"
      :closable="false"
      show-icon
      style="margin-bottom: 14px"
      title="这条记录在另一台设备（或另一个页面）上也被修改过"
      :description="`服务端版本保存于 ${remoteTimeText()}。系统已按各字段的修改时间给出建议，请逐项确认后再入库。`"
    />

    <div v-for="row in rows" :key="row.field" class="conflict-row">
      <div class="conflict-row__label">
        {{ row.label }}
        <el-tag v-if="chosenSide[row.field] === row.suggested" size="small" type="success">建议</el-tag>
      </div>

      <el-radio-group
        :model-value="chosenSide[row.field]"
        @update:model-value="(side: 'local' | 'remote') => choose(row.field, side)"
      >
        <el-radio value="local">本机</el-radio>
        <el-radio value="remote">其他设备</el-radio>
      </el-radio-group>

      <div class="conflict-row__values">
        <div
          class="conflict-cell"
          :class="{ 'conflict-cell--active': chosenSide[row.field] === 'local' }"
          @click="choose(row.field, 'local')"
        >
          <span class="conflict-cell__tag">本机</span>
          <span class="conflict-cell__text">{{ formatValue(row.field, "local") }}</span>
        </div>
        <div
          class="conflict-cell"
          :class="{ 'conflict-cell--active': chosenSide[row.field] === 'remote' }"
          @click="choose(row.field, 'remote')"
        >
          <span class="conflict-cell__tag">其他设备</span>
          <span class="conflict-cell__text">{{ formatValue(row.field, "remote") }}</span>
        </div>
      </div>

      <el-input
        v-if="editableTextFields.has(row.field)"
        :model-value="String(finalPayload[row.field] ?? '')"
        type="textarea"
        :rows="row.field === 'description' ? 3 : 1"
        placeholder="也可以直接在这里写出最终内容"
        @update:model-value="(text: string) => (finalPayload = { ...finalPayload, [row.field]: text })"
      />
    </div>

    <template #footer>
      <el-button @click="discard">放弃本机修改</el-button>
      <el-button @click="close">稍后处理</el-button>
      <el-button type="primary" :loading="saving" @click="confirm">确认入库</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.conflict-row {
  border-bottom: 1px solid var(--color-border);
  padding: 12px 0;
}

.conflict-row__label {
  font-weight: 600;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.conflict-row__values {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}

.conflict-cell {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  cursor: pointer;
  background: var(--color-bg);
}

.conflict-cell--active {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 1px var(--color-primary) inset;
}

.conflict-cell__tag {
  display: inline-block;
  font-size: 12px;
  color: var(--color-text-soft);
  margin-right: 6px;
}

.conflict-cell__text {
  font-size: 13px;
  word-break: break-word;
}

@media (max-width: 560px) {
  .conflict-row__values {
    flex-direction: column;
  }
}
</style>
