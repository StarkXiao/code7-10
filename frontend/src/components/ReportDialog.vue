<script setup lang="ts">
import { ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { api } from "@/api/client";
import { useCatalogStore } from "@/stores/catalog";

const props = defineProps<{
  visible: boolean;
  targetType: "spot" | "comment" | "media" | "user";
  targetId: string;
}>();

const emit = defineEmits<{
  (event: "update:visible", value: boolean): void;
  (event: "submitted"): void;
}>();

const catalog = useCatalogStore();
const reason = ref("");
const detail = ref("");
const submitting = ref(false);

watch(
  () => props.visible,
  (open) => {
    if (open) {
      reason.value = "";
      detail.value = "";
      catalog.load().catch(() => undefined);
    }
  },
);

async function submit() {
  if (!reason.value) {
    ElMessage.warning("请选择举报类型");
    return;
  }

  submitting.value = true;
  try {
    await api.post("/reports", {
      targetType: props.targetType,
      targetId: props.targetId,
      reason: reason.value,
      detail: detail.value || undefined,
    });
    ElMessage.success("举报已提交，处理完成后会通知你");
    emit("update:visible", false);
    emit("submitted");
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="举报这条内容"
    width="440px"
    @update:model-value="(value: boolean) => emit('update:visible', value)"
  >
    <el-form label-position="top">
      <el-form-item label="举报类型" required>
        <el-radio-group v-model="reason">
          <el-radio v-for="item in catalog.meta.reportReasons" :key="item.code" :value="item.code">
            {{ item.label }}
          </el-radio>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="补充说明">
        <el-input
          v-model="detail"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          placeholder="选填。如果涉及隐私内容，处理时限会缩短到 24 小时内。"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:visible', false)">取消</el-button>
      <el-button type="danger" :loading="submitting" @click="submit">提交举报</el-button>
    </template>
  </el-dialog>
</template>
