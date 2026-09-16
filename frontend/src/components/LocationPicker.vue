<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import L from "leaflet";
import { MAP_TILE_ATTRIBUTION, MAP_TILE_URL } from "@/config/map";

const props = defineProps<{
  lat: number;
  lng: number;
  fuzzRadius: number;
  fuzzEnabled: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (event: "update", payload: { lat: number; lng: number }): void;
}>();

const container = ref<HTMLDivElement | null>(null);
const map = shallowRef<L.Map | null>(null);
const marker = shallowRef<L.Marker | null>(null);
const circle = shallowRef<L.Circle | null>(null);

function syncCircle(lat: number, lng: number) {
  const instance = map.value;
  if (!instance) return;

  if (circle.value) {
    instance.removeLayer(circle.value);
    circle.value = null;
  }

  if (props.fuzzEnabled && props.fuzzRadius > 0) {
    circle.value = L.circle([lat, lng], {
      radius: props.fuzzRadius,
      color: "#16a085",
      weight: 1,
      fillOpacity: 0.12,
      interactive: false,
    }).addTo(instance);
  }
}

function place(lat: number, lng: number, notify = true) {
  const instance = map.value;
  const point = marker.value;
  if (!instance || !point) return;

  point.setLatLng([lat, lng]);
  syncCircle(lat, lng);
  if (notify) emit("update", { lat, lng });
}

onMounted(() => {
  if (!container.value) return;

  const instance = L.map(container.value, {
    center: [props.lat, props.lng],
    zoom: 17,
  });

  L.tileLayer(MAP_TILE_URL, {
    attribution: MAP_TILE_ATTRIBUTION,
    maxZoom: 19,
  }).addTo(instance);

  const point = L.marker([props.lat, props.lng], { draggable: !props.disabled }).addTo(instance);
  point.on("dragend", () => {
    const position = point.getLatLng();
    place(position.lat, position.lng);
  });

  instance.on("click", (event: L.LeafletMouseEvent) => {
    if (props.disabled) return;
    place(event.latlng.lat, event.latlng.lng);
  });

  map.value = instance;
  marker.value = point;
  syncCircle(props.lat, props.lng);

  setTimeout(() => instance.invalidateSize(), 120);
});

onBeforeUnmount(() => {
  map.value?.remove();
  map.value = null;
  marker.value = null;
  circle.value = null;
});

watch(
  () => [props.lat, props.lng],
  ([lat, lng]) => {
    if (typeof lat !== "number" || typeof lng !== "number") return;
    const current = marker.value?.getLatLng();
    if (current && Math.abs(current.lat - lat) < 1e-7 && Math.abs(current.lng - lng) < 1e-7) return;
    place(lat, lng, false);
    map.value?.panTo([lat, lng]);
  },
);

watch(
  () => [props.fuzzEnabled, props.fuzzRadius],
  () => syncCircle(props.lat, props.lng),
);
</script>

<template>
  <div class="location-picker">
    <div ref="container" class="location-picker__map" />
    <p class="muted location-picker__hint">
      拖动图钉或点击地图来调整位置。绿色圆圈表示对外展示时的模糊范围。
    </p>
  </div>
</template>

<style scoped>
.location-picker__map {
  height: 260px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  overflow: hidden;
}

.location-picker__hint {
  margin: 6px 0 0;
}
</style>
