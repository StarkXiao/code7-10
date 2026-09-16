<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import L from "leaflet";
import "leaflet.markercluster";
import type { Spot } from "@/api/types";
import { DEFAULT_CENTER, DEFAULT_ZOOM, MAP_TILE_ATTRIBUTION, MAP_TILE_URL } from "@/config/map";

const props = withDefaults(
  defineProps<{
    spots: Spot[];
    center?: [number, number];
    zoom?: number;
    selectedUuid?: string | null;
    interactiveRadius?: number | null;
  }>(),
  {
    center: () => [...DEFAULT_CENTER] as [number, number],
    zoom: DEFAULT_ZOOM,
    selectedUuid: null,
    interactiveRadius: null,
  },
);

const emit = defineEmits<{
  (event: "select", uuid: string): void;
  (event: "bounds", bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }): void;
  (event: "ready"): void;
}>();

const container = ref<HTMLDivElement | null>(null);
const map = shallowRef<L.Map | null>(null);
const cluster = shallowRef<L.MarkerClusterGroup | null>(null);
const markers = new Map<string, L.Marker>();
let fuzzCircle: L.Circle | null = null;

function buildIcon(spot: Spot, selected: boolean): L.DivIcon {
  const color = spot.category.color || "#16a085";
  const size = selected ? 30 : 24;
  const stale = spot.freshness.isStale;

  return L.divIcon({
    className: "psdm-marker",
    html: `
      <div style="
        width:${size}px;height:${size}px;border-radius:50% 50% 50% 6px;
        transform:rotate(-45deg);
        background:${stale ? "#9ca3af" : color};
        border:2px solid #fff;
        box-shadow:0 2px 6px rgba(15,23,42,.35);
        display:flex;align-items:center;justify-content:center;
      ">
        <span style="
          transform:rotate(45deg);color:#fff;font-size:${selected ? 13 : 11}px;
          font-weight:700;line-height:1;
        ">${stale ? "?" : spot.category.name.slice(0, 1)}</span>
      </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size],
  });
}

function currentBbox() {
  const instance = map.value;
  if (!instance) return null;
  const bounds = instance.getBounds();
  return {
    minLng: bounds.getWest(),
    minLat: bounds.getSouth(),
    maxLng: bounds.getEast(),
    maxLat: bounds.getNorth(),
  };
}

function renderMarkers() {
  const group = cluster.value;
  const instance = map.value;
  if (!group || !instance) return;

  group.clearLayers();
  markers.clear();

  for (const spot of props.spots) {
    const marker = L.marker([spot.location.lat, spot.location.lng], {
      icon: buildIcon(spot, spot.uuid === props.selectedUuid),
      title: spot.title,
    });

    marker.on("click", () => emit("select", spot.uuid));
    markers.set(spot.uuid, marker);
    group.addLayer(marker);
  }
}

function renderSelection() {
  const instance = map.value;
  if (!instance) return;

  if (fuzzCircle) {
    instance.removeLayer(fuzzCircle);
    fuzzCircle = null;
  }

  for (const [uuid, marker] of markers) {
    const spot = props.spots.find((item) => item.uuid === uuid);
    if (!spot) continue;
    marker.setIcon(buildIcon(spot, uuid === props.selectedUuid));
  }

  const selected = props.spots.find((spot) => spot.uuid === props.selectedUuid);
  if (!selected) return;

  // 位置被模糊过时画一个半透明圆圈，
  // 让用户明白"实际位置在这个范围内"，而不是以为坐标不准。
  if (selected.location.fuzzed && selected.location.radiusMeters > 0) {
    fuzzCircle = L.circle([selected.location.lat, selected.location.lng], {
      radius: selected.location.radiusMeters,
      color: selected.category.color || "#16a085",
      weight: 1,
      fillOpacity: 0.12,
      interactive: false,
    }).addTo(instance);
  }
}

onMounted(() => {
  if (!container.value) return;

  const instance = L.map(container.value, {
    center: props.center,
    zoom: props.zoom,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer(MAP_TILE_URL, {
    attribution: MAP_TILE_ATTRIBUTION,
    maxZoom: 19,
  }).addTo(instance);

  const group = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 56,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 17,
  });
  instance.addLayer(group);

  map.value = instance;
  cluster.value = group;

  instance.on("moveend", () => {
    const bbox = currentBbox();
    if (bbox) emit("bounds", bbox);
  });

  renderMarkers();

  // 等容器完成布局再算尺寸，否则地图会出现灰边
  setTimeout(() => {
    instance.invalidateSize();
    emit("ready");
  }, 120);
});

onBeforeUnmount(() => {
  map.value?.remove();
  map.value = null;
  cluster.value = null;
  markers.clear();
});

watch(() => props.spots, renderMarkers, { deep: false });
watch(() => props.selectedUuid, renderSelection);
watch(
  () => [props.spots.length, props.selectedUuid],
  () => renderSelection(),
);

defineExpose({
  flyTo(lat: number, lng: number, zoom = 17) {
    map.value?.flyTo([lat, lng], zoom, { duration: 0.6 });
  },
  getBbox: currentBbox,
  invalidate() {
    map.value?.invalidateSize();
  },
});
</script>

<template>
  <div ref="container" class="base-map" />
</template>

<style scoped>
.base-map {
  width: 100%;
  height: 100%;
  min-height: 320px;
  background: #eef1f4;
}
</style>
