// 地图相关配置统一在这里解析。
//
// 关键点：每一项都必须有可用的默认值。
// frontend/.env 不会进仓库（里面是本机地址），别人克隆后没有这个文件，
// 如果瓦片地址是 undefined，Leaflet 会直接报错、地图变白屏。
const env = import.meta.env;

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const MAP_TILE_URL =
  env.VITE_MAP_TILE_URL || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

export const MAP_TILE_ATTRIBUTION = env.VITE_MAP_TILE_ATTRIBUTION || "© OpenStreetMap contributors";

export const DEFAULT_CENTER: [number, number] = [
  numberOr(env.VITE_DEFAULT_CENTER_LAT, 31.2304),
  numberOr(env.VITE_DEFAULT_CENTER_LNG, 121.4737),
];

export const DEFAULT_ZOOM = numberOr(env.VITE_DEFAULT_ZOOM, 14);
