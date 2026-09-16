import { deterministicRandom } from "../../utils/crypto";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

const EARTH_RADIUS_M = 6371008.8;
const METERS_PER_DEG_LAT = 111320;

export interface LatLng {
  lat: number;
  lng: number;
}

export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 确定性位置模糊化。
 *
 * 同一个 spotlight（seed = spot.uuid）永远得到同一个偏移量，
 * 因此地图刷新时标记不会"乱跳"；同时偏移量在半径内均匀分布，
 * 不会因为总是往同一方向偏移而泄露真实方位。
 */
export function fuzzCoordinates(origin: LatLng, radiusMeters: number, seed: string): LatLng {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    return { lat: origin.lat, lng: origin.lng };
  }

  const angle = deterministicRandom(seed, "fuzz-angle") * Math.PI * 2;
  // sqrt 保证在圆内均匀分布，否则会过度集中在圆心
  const distance = Math.sqrt(deterministicRandom(seed, "fuzz-distance")) * radiusMeters;

  const deltaLat = (distance * Math.cos(angle)) / METERS_PER_DEG_LAT;
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.max(0.01, Math.abs(cosLat));
  const deltaLng = (distance * Math.sin(angle)) / metersPerDegLng;

  return {
    lat: Number((origin.lat + deltaLat).toFixed(6)),
    lng: Number((origin.lng + deltaLng).toFixed(6)),
  };
}

/** 经纬度包围盒（用于 bbox 查询） */
export function boundingBox(center: LatLng, radiusMeters: number) {
  const latDelta = radiusMeters / METERS_PER_DEG_LAT;
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  const lngDelta = radiusMeters / (METERS_PER_DEG_LAT * Math.max(0.01, Math.abs(cosLat)));
  return {
    minLat: center.lat - latDelta,
    maxLat: center.lat + latDelta,
    minLng: center.lng - lngDelta,
    maxLng: center.lng + lngDelta,
  };
}

/** 把地址裁剪到街道级别，不展示门牌号 */
function toStreetLevel(displayName: string): string {
  const parts = displayName
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  // 去掉门牌号这类最细粒度的片段
  const filtered = parts.filter((part) => !/^\d+[\u4e00-\u9fa5]?号?$/.test(part) && !/^\d+$/.test(part));
  return filtered.slice(0, 4).join(" ").slice(0, 120);
}

export interface ReverseGeocodeResult {
  /** 裁剪到街道级别的地址文本 */
  address: string | null;
  /** OSM 要素大类，用于识别水域、建筑等无效区域 */
  featureClass?: string;
  featureType?: string;
}

/**
 * 反向地理编码。
 * 结果只用于展示"大致在哪"与判断明显无效的位置，
 * 任何失败都降级为 address=null，不阻塞提交——坐标才是主数据。
 */
export async function reverseGeocode(point: LatLng): Promise<ReverseGeocodeResult | null> {
  if (env.GEOCODING_PROVIDER === "none") return null;

  try {
    if (env.GEOCODING_PROVIDER === "amap" && env.GEOCODING_API_KEY) {
      const url = new URL("https://restapi.amap.com/v3/geocode/regeo");
      url.searchParams.set("key", env.GEOCODING_API_KEY);
      url.searchParams.set("location", `${point.lng},${point.lat}`);

      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = (await response.json()) as {
        status?: string;
        regeocode?: { formatted_address?: string };
      };
      const address = payload.regeocode?.formatted_address;
      return { address: address ? toStreetLevel(address) : null };
    }

    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(point.lat));
    url.searchParams.set("lon", String(point.lng));
    url.searchParams.set("zoom", "17");
    url.searchParams.set("accept-language", "zh-CN");

    const response = await fetch(url, {
      headers: {
        // Nominatim 使用政策要求带可识别的 User-Agent
        "User-Agent": "public-space-detail-map/1.0 (contact: ops@example.com)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = (await response.json()) as {
      display_name?: string;
      category?: string;
      class?: string;
      type?: string;
    };
    return {
      address: payload.display_name ? toStreetLevel(payload.display_name) : null,
      featureClass: payload.class ?? payload.category,
      featureType: payload.type,
    };
  } catch (error) {
    logger.debug({ err: (error as Error).message }, "反向地理编码失败，已跳过");
    return null;
  }
}

export { toStreetLevel };
