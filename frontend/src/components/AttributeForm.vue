<script setup lang="ts">
import { computed } from "vue";
import type { AttributeSchema, CategoryAttribute } from "@/api/types";

const props = defineProps<{
  schema: AttributeSchema | null;
  modelValue: Record<string, unknown>;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: Record<string, unknown>): void;
}>();

// 表单完全由后端下发的 Schema 驱动：
// 新增属性、改选项、调必填项都不需要改前端代码。
const entries = computed(() =>
  Object.entries(props.schema?.properties ?? {}).map(([key, property]) => ({
    key,
    property,
    required: (props.schema?.required ?? []).includes(key),
  })),
);

function labelOf(property: CategoryAttribute, key: string): string {
  return property.label ?? key;
}

function optionLabel(property: CategoryAttribute, value: string): string {
  return property.enumLabels?.[value] ?? value;
}

function update(key: string, value: unknown) {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}

function reset(key: string) {
  const next = { ...props.modelValue };
  delete next[key];
  emit("update:modelValue", next);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}
</script>

<template>
  <div v-if="entries.length" class="attribute-form">
    <div v-for="entry in entries" :key="entry.key" class="attribute-form__row">
      <label class="attribute-form__label">
        {{ labelOf(entry.property, entry.key) }}
        <span v-if="entry.required" class="attribute-form__required">*</span>
        <span v-if="entry.property.unit" class="muted">（{{ entry.property.unit }}）</span>
      </label>

      <div class="attribute-form__control">
        <!-- 布尔：开关 -->
        <el-switch
          v-if="entry.property.type === 'boolean'"
          :model-value="modelValue[entry.key] === true"
          :disabled="disabled"
          @update:model-value="(value: boolean) => update(entry.key, value)"
        />

        <!-- 数字：整数/小数 -->
        <el-input-number
          v-else-if="entry.property.type === 'integer' || entry.property.type === 'number'"
          :model-value="asNumber(modelValue[entry.key])"
          :min="entry.property.minimum"
          :max="entry.property.maximum"
          :step="entry.property.type === 'integer' ? 1 : 0.5"
          :precision="entry.property.type === 'integer' ? 0 : 1"
          :disabled="disabled"
          controls-position="right"
          @update:model-value="(value: number | undefined) => update(entry.key, value)"
        />

        <!-- 多选 -->
        <el-checkbox-group
          v-else-if="entry.property.type === 'array'"
          :model-value="asArray(modelValue[entry.key])"
          :disabled="disabled"
          @update:model-value="(value: string[]) => update(entry.key, value)"
        >
          <el-checkbox
            v-for="option in entry.property.items?.enum ?? []"
            :key="option"
            :value="option"
          >
            {{ entry.property.items?.enumLabels?.[option] ?? option }}
          </el-checkbox>
        </el-checkbox-group>

        <!-- 枚举单选 -->
        <el-select
          v-else-if="entry.property.enum?.length"
          :model-value="asText(modelValue[entry.key])"
          :disabled="disabled"
          clearable
          placeholder="请选择"
          style="width: 100%; max-width: 320px"
          @update:model-value="(value: string | undefined) => (value ? update(entry.key, value) : reset(entry.key))"
        >
          <el-option
            v-for="option in entry.property.enum"
            :key="option"
            :label="optionLabel(entry.property, option)"
            :value="option"
          />
        </el-select>

        <!-- 短文本 -->
        <el-input
          v-else
          :model-value="asText(modelValue[entry.key])"
          :maxlength="entry.property.maxLength ?? 80"
          :disabled="disabled"
          placeholder="可留空"
          style="max-width: 320px"
          @update:model-value="(value: string) => update(entry.key, value)"
        />

        <p v-if="entry.property.help" class="attribute-form__help">{{ entry.property.help }}</p>
      </div>
    </div>
  </div>

  <el-empty v-else description="该分类暂无可填写的细节项" :image-size="70" />
</template>

<style scoped>
.attribute-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.attribute-form__row {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.attribute-form__label {
  width: 132px;
  flex-shrink: 0;
  font-size: 14px;
  padding-top: 6px;
  color: var(--color-text);
}

.attribute-form__required {
  color: var(--color-danger);
  margin-left: 2px;
}

.attribute-form__control {
  flex: 1;
  min-width: 0;
}

.attribute-form__help {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--color-text-soft);
}

@media (max-width: 720px) {
  .attribute-form__row {
    flex-direction: column;
    gap: 6px;
  }

  .attribute-form__label {
    width: auto;
    padding-top: 0;
  }
}
</style>
