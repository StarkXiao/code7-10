import { describe, expect, it } from "vitest";
import { boundingBox, fuzzCoordinates, haversineMeters, isValidLatLng } from "../../src/services/geo";

describe("位置模糊化", () => {
  const origin = { lat: 31.2304, lng: 121.4737 };

  it("同一个地点每次得到完全相同的结果，地图上不会乱跳", () => {
    const first = fuzzCoordinates(origin, 50, "spot-uuid-1");
    const second = fuzzCoordinates(origin, 50, "spot-uuid-1");
    expect(first).toEqual(second);
  });

  it("不同地点得到不同的偏移", () => {
    const a = fuzzCoordinates(origin, 50, "spot-uuid-1");
    const b = fuzzCoordinates(origin, 50, "spot-uuid-2");
    expect(a).not.toEqual(b);
  });

  it("偏移距离不会超过设定半径", () => {
    for (let i = 0; i < 200; i += 1) {
      const point = fuzzCoordinates(origin, 50, `seed-${i}`);
      expect(haversineMeters(origin, point)).toBeLessThanOrEqual(50.5);
    }
  });

  it("半径为 0 时不偏移", () => {
    expect(fuzzCoordinates(origin, 0, "seed")).toEqual(origin);
  });

  it("卫星坐标与距离计算符合常识", () => {
    const shanghai = { lat: 31.2304, lng: 121.4737 };
    const beijing = { lat: 39.9042, lng: 116.4074 };
    const distance = haversineMeters(shanghai, beijing);
    // 上海到北京直线距离约 1070 公里
    expect(distance).toBeGreaterThan(1000000);
    expect(distance).toBeLessThan(1150000);
  });

  it("包围盒把中心点包在里面", () => {
    const box = boundingBox(origin, 1000);
    expect(box.minLat).toBeLessThan(origin.lat);
    expect(box.maxLat).toBeGreaterThan(origin.lat);
    expect(box.minLng).toBeLessThan(origin.lng);
    expect(box.maxLng).toBeGreaterThan(origin.lng);
  });

  it("拒绝非法坐标", () => {
    expect(isValidLatLng(31.2, 121.4)).toBe(true);
    expect(isValidLatLng(91, 121.4)).toBe(false);
    expect(isValidLatLng(31.2, 181)).toBe(false);
    expect(isValidLatLng(Number.NaN, 121.4)).toBe(false);
  });
});
