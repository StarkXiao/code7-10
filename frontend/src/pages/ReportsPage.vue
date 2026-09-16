<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "@/api/client";
import type { Paged, ReportItem } from "@/api/types";

const items = ref<ReportItem[]>([]);
const loading = ref(false);
const detail = ref<Record<string, unknown> | null>(null);
const detailVisible = ref(false);
const note = ref("");
const acting = ref(false);

// 详情结构随对象类型不同，这里统一取出模板里要用到的字段，
// 避免在模板中做类型断言。
const reporterName = computed(() => {
  const reporter = detail.value?.reporter as { nickname?: string } | undefined;
  return reporter?.nickname ?? "未知";
});

const reporterResolvedCount = computed(() => {
  const reporter = detail.value?.reporter as { resolvedReports?: number } | undefined;
  return reporter?.resolvedReports ?? 0;
});

const snapshotText = computed(() => JSON.stringify(detail.value?.targetSnapshot ?? null, null, 2));
const targetId = computed(() => String(detail.value?.targetId ?? ""));
const targetLabel = computed(() => String(detail.value?.targetLabel ?? ""));
const reasonLabel = computed(() => String(detail.value?.reasonLabel ?? ""));
const detailText = computed(() => String(detail.value?.detail ?? "—"));
const privacySensitive = computed(() => Boolean(detail.value?.privacySensitive));

async function load() {
  loading.value = true;
  try {
    const result = await api.get<Paged<ReportItem>>("/moderation/reports", { pageSize: 50 });
    items.value = result.items;
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

async function openDetail(item: ReportItem) {
  try {
    detail.value = await api.get<Record<string, unknown>>(`/moderation/reports/${item.id}`);
    note.value = "";
    detailVisible.value = true;
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function decide(action: "resolve" | "dismiss") {
  if (!detail.value || note.value.trim().length < 2) {
    ElMessage.warning("请填写至少 2 个字的处理说明");
    return;
  }

  acting.value = true;
  try {
    await api.post(`/moderation/reports/${detail.value.id}/${action}`, { note: note.value.trim() });
    ElMessage.success(action === "resolve" ? "已处置并通知双方" : "已判定不成立并通知举报人");
    detailVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    acting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page page--wide">
    <h1 class="page-title">
      举报处置
      <el-button size="small" @click="load">刷新</el-button>
    </h1>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="隐私类举报必须在 24 小时内处置"
      description="标记为「隐私」的工单排在前面。举报成立时，相关图片的公开版本会立即失效，避免缓存继续暴露内容。"
      style="margin-bottom: 16px"
    />

    <el-table v-loading="loading" :data="items" style="width: 100%">
      <el-table-column label="对象" width="110">
        <template #default="{ row }">{{ row.targetLabel }}</template>
      </el-table-column>

      <el-table-column label="举报类型" min-width="180">
        <template #default="{ row }">
          <el-tag v-if="row.privacySensitive" type="danger" size="small">隐私</el-tag>
          <span style="margin-left: 6px">{{ row.reasonLabel }}</span>
          <div v-if="row.relatedCount" class="muted">另有 {{ row.relatedCount }} 条同类举报已合并</div>
        </template>
      </el-table-column>

      <el-table-column label="说明" min-width="200">
        <template #default="{ row }">{{ row.detail || "—" }}</template>
      </el-table-column>

      <el-table-column label="举报人" width="120">
        <template #default="{ row }">{{ row.reporter.nickname }}</template>
      </el-table-column>

      <el-table-column label="时限" width="140">
        <template #default="{ row }">
          <el-tag v-if="row.overdue" type="danger" size="small">已超时</el-tag>
          <span v-else class="muted">{{ new Date(row.slaDueAt).toLocaleString("zh-CN") }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" @click="openDetail(row)">处理</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-if="!loading && items.length === 0" description="没有待处理的举报" />

    <el-dialog v-model="detailVisible" title="举报详情" width="640px">
      <template v-if="detail">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="对象">{{ targetLabel }} #{{ targetId }}</el-descriptions-item>
          <el-descriptions-item label="举报类型">
            {{ reasonLabel }}
            <el-tag v-if="privacySensitive" type="danger" size="small" style="margin-left: 6px">隐私</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="说明">{{ detailText }}</el-descriptions-item>
          <el-descriptions-item label="举报人">
            {{ reporterName }}（历史有效举报 {{ reporterResolvedCount }} 次）
          </el-descriptions-item>
        </el-descriptions>

        <el-divider>被举报对象的当前内容</el-divider>
        <pre class="diff-block">{{ snapshotText }}</pre>

        <el-divider />
        <el-input
          v-model="note"
          type="textarea"
          :rows="3"
          maxlength="300"
          show-word-limit
          placeholder="处理说明，会同时通知举报人与被举报人"
        />
      </template>

      <template #footer>
        <el-button @click="detailVisible = false">取消</el-button>
        <el-button :loading="acting" @click="decide('dismiss')">举报不成立</el-button>
        <el-button type="danger" :loading="acting" @click="decide('resolve')">举报成立并处置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.diff-block {
  max-height: 240px;
  overflow: auto;
  background: var(--color-bg);
  padding: 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}
</style>
