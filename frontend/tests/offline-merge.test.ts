import { describe, expect, it } from "vitest";
import {
  buildMergeProposal,
  flattenSpotFields,
  unflattenSpotFields,
  valuesEqual,
} from "@/offline/merge";

describe("离线字段级合并（前端）", () => {
  it("草稿载荷展平后属性以 attributes. 前缀存在，且可还原", () => {
    const flat = flattenSpotFields({
      categoryCode: "bench",
      title: "标题",
      description: "描述",
      attributes: { has_backrest: true },
      lat: 31.2,
      lng: 121.4,
      fuzzEnabled: true,
      fuzzRadiusM: 50,
      mediaUuids: [],
    });
    expect(flat["attributes.has_backrest"]).toBe(true);
    expect(flat.lat).toBe(31.2);

    const restored = unflattenSpotFields(flat);
    expect(restored.categoryCode).toBe("bench");
    expect(restored.attributes).toEqual({ has_backrest: true });
  });

  it("valuesEqual 对数组顺序敏感", () => {
    expect(valuesEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(valuesEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it("只有一端改动的字段自动合并，不进入冲突列表", () => {
    const result = buildMergeProposal({
      base: { title: "旧", description: "旧描述" },
      server: { title: "旧", description: "服务端改了描述" },
      client: { title: "本机改了标题", description: "旧描述" },
      serverTimestamps: { description: "2026-09-19T10:00:00Z" },
      clientTimestamps: { title: "2026-09-19T11:00:00Z" },
    });
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged.title).toBe("本机改了标题");
    expect(result.merged.description).toBe("服务端改了描述");
  });

  it("两端同改同字段按时间戳预选较新值，并标记为待用户确认", () => {
    const result = buildMergeProposal({
      base: { title: "旧" },
      server: { title: "服务端值" },
      client: { title: "本机值" },
      serverTimestamps: { title: "2026-09-19T12:00:00Z" },
      clientTimestamps: { title: "2026-09-19T10:00:00Z" },
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.winner).toBe("server");
    expect(result.merged.title).toBe("服务端值");
  });

  it("属性按 key 独立合并：各改一个属性不算冲突", () => {
    const result = buildMergeProposal({
      base: { "attributes.a": 1, "attributes.b": 2 },
      server: { "attributes.a": 10, "attributes.b": 2 },
      client: { "attributes.a": 1, "attributes.b": 20 },
      serverTimestamps: { "attributes.a": "2026-09-19T10:00:00Z" },
      clientTimestamps: { "attributes.b": "2026-09-19T10:00:00Z" },
    });
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged["attributes.a"]).toBe(10);
    expect(result.merged["attributes.b"]).toBe(20);
  });
});
