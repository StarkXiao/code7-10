<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api } from "@/api/client";
import type { Paged, Spot } from "@/api/types";
import { useAuthStore } from "@/stores/auth";
import { useCatalogStore } from "@/stores/catalog";
import BaseMap from "@/components/BaseMap.vue";

const auth = useAuthStore();
const catalog = useCatalogStore();
const router = useRouter();

const spots = ref<Spot[]>([]);
const loading = ref(false);
const selectedUuid = ref<string | null>(null);
const total = ref(0);

const filters = ref({
  categories: [] as string[],
  keyword: "",
  freshOnly: false,
  sort: "freshness" as "freshness" | "distance" | "newest",
});

let bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number } | null = null;
let near: { lat: number; lng: number } | null = null;
let debounceTimer: number | undefined;

const selectedSpot = computed(() => spots.value.find((spot) => spot.uuid === selectedUuid.value) ?? null);

async function fetchSpots() {
  loading.value = true;
  try {
    const result = await api.get<Paged<Spot>>("/spots", {
      bbox: bbox && !near ? `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}` : undefined,
      near: near ? `${near.lat},${near.lng}` : undefined,
      radius: near ? 1500 : undefined,
      category: filters.value.categories,
      q: filters.value.keyword || undefined,
      fresh: filters.value.freshOnly ? "true" : undefined,
      sort: near ? "distance" : filters.value.sort,
      pageSize: 100,
    });

    spots.value = result.items;
    total.value = result.total;

    if (selectedUuid.value && !result.items.some((item) => item.uuid === selectedUuid.value)) {
      selectedUuid.value = null;
    }
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

// 地图每次移动都会触发 bounds，加个防抖避免把接口打爆
function onBounds(next: typeof bbox) {
  bbox = next;
  if (near) return;
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => void fetchSpots(), 400);
}

function useMyLocation() {
  if (!navigator.geolocation) {
    ElMessage.warning("当前浏览器不支持定位，请直接在地图上浏览");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      near = { lat: position.coords.latitude, lng: position.coords.longitude };
      filters.value.sort = "distance";
      void fetchSpots();
    },
    () => {
      // 定位失败时给出可执行的降级方案，而不是只弹一句报错
      ElMessage.warning("定位失败。你可以直接拖动地图，或在上方输入关键词搜索。");
    },
    { timeout: 8000 },
  );
}

function clearNear() {
  near = null;
  void fetchSpots();
}

function goDetail(uuid: string) {
  void router.push({ name: "spot-detail", params: { uuid } });
}

function goCreate() {
  if (!auth.isLoggedIn) {
    void router.push({ name: "login", query: { redirect: "/spots/new" } });
    return;
  }
  void router.push({ name: "spot-new" });
}

onMounted(async () => {
  await catalog.load().catch(() => undefined);
});

const hasActiveFilter = computed(
  () => filters.value.categories.length > 0 || Boolean(filters.value.keyword) || filters.value.freshOnly || Boolean(near),
);

function resetFilters() {
  filters.value.categories = [];
  filters.value.keyword = "";
  filters.value.freshOnly = false;
  near = null;
  void fetchSpots();
}
</script>

<template>
  <div class="map-layout">
    <div class="map-panel">
      <BaseMap
        :spots="spots"
        :selected-uuid="selectedUuid"
        @select="(uuid: string) => (selectedUuid = uuid)"
        @bounds="onBounds"
        @ready="fetchSpots"
      />

      <el-button class="map-fab" type="primary" size="large" @click="goCreate">
        <el-icon style="margin-right: 6px"><Plus /></el-icon>
        记录一个细节
      </el-button>

      <div class="fuzz-note">
        地图上的位置默认经过模糊处理，实际位置在标记附近。
      </div>
    </div>

    <aside class="map-side">
      <div class="map-side__header">
        <el-input v-model="filters.keyword" placeholder="搜索地点、地址或关键词" clearable @keyup.enter="fetchSpots">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>

        <el-select v-model="filters.categories" multiple collapse-tags placeholder="全部分类" clearable>
          <el-option
            v-for="category in catalog.categories"
            :key="category.code"
            :label="category.name"
            :value="category.code"
          />
        </el-select>

        <div class="map-side__filters">
          <el-checkbox v-model="filters.freshOnly">只看近期确认过的</el-checkbox>
          <el-select v-model="filters.sort" size="small" style="width: 116px" :disabled="Boolean(near)">
            <el-option label="最新鲜" value="freshness" />
            <el-option label="最新发布" value="newest" />
            <el-option label="距离最近" value="distance" />
          </el-select>
        </div>

        <div class="map-side__filters">
          <el-button size="small" @click="useMyLocation">
            <el-icon style="margin-right: 4px"><LocationInformation /></el-icon>
            附近的
          </el-button>
          <el-button v-if="near" size="small" text @click="clearNear">取消附近筛选</el-button>
          <el-button v-if="hasActiveFilter" size="small" text @click="resetFilters">重置</el-button>
          <span class="muted" style="margin-left: auto">共 {{ total }} 条</span>
        </div>
      </div>

      <div v-loading="loading" class="map-side__list">
        <el-empty v-if="!loading && spots.length === 0" description="这一片还没有人记录过，欢迎你来补充第一个" />

        <article
          v-for="spot in spots"
          :key="spot.uuid"
          class="spot-card"
          :class="{ 'spot-card--active': spot.uuid === selectedUuid }"
          @click="selectedUuid = spot.uuid"
        >
          <div class="spot-card__head">
            <span class="category-chip" :style="{ background: spot.category.color }">
              {{ spot.category.name }}
            </span>
            <span class="spot-card__title">{{ spot.title }}</span>
          </div>

          <p class="muted" style="margin: 0">
            {{ spot.description || "还没有补充描述" }}
          </p>

          <div class="spot-card__meta">
            <span class="badge">{{ spot.freshness.confirmCount }} 人确认过</span>
            <span v-if="spot.freshness.isStale" class="badge badge--warn">信息可能已过期</span>
            <span v-if="spot.distanceMeters !== undefined" class="badge">
              约 {{ spot.distanceMeters }} 米
            </span>
            <span v-if="spot.media.length" class="badge">{{ spot.media.length }} 张图</span>
          </div>

          <div class="spot-card__actions">
            <el-button size="small" text @click.stop="goDetail(spot.uuid)">查看详情</el-button>
          </div>
        </article>

        <el-card v-if="selectedSpot" shadow="never" class="spot-card--selected">
          <h4 style="margin: 0 0 8px">{{ selectedSpot.title }}</h4>
          <p class="muted" style="margin: 0 0 10px">{{ selectedSpot.category.name }}</p>
          <el-button size="small" type="primary" @click="goDetail(selectedSpot.uuid)">查看完整信息</el-button>
        </el-card>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.map-side__filters {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spot-card--active {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-md);
}

.spot-card__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}

.spot-card--selected {
  border: 1px solid var(--color-primary);
}
</style>
