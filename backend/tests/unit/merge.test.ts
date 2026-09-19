import { describe, expect, it } from "vitest";
import {
  buildMergeProposal,
  flattenSpotFields,
  unflattenSpotFields,
} from "../../src/modules/spots/merge";

describe("多端离线字段级合并", () => {
  it("标量字段与属性字段都能展平/还原", () => {
    const flat = flattenSpotFields({
      categoryCode: "bench",
      title: "标题",
      description: null,
      attributes: { has_backrest: true, count: 3 },
      lat: 31.2,
      lng: 121.4,
      fuzzEnabled: true,
      fuzzRadiusM: 50,
      mediaUuids: ["u1"],
    });

    expect(flat.title).toBe("标题");
    expect(flat["attributes.has_backrest"]).toBe(true);
    expect(flat["attributes.count"]).toBe(3);
    expect(flat.mediaUuids).toEqual(["u1"]);

    const restored = unflattenSpotFields(flat);
    expect(restored.categoryCode).toBe("bench");
    expect(restored.attributes).toEqual({ has_backrest: true, count: 3 });
  });

  it("只有一端改动时直接采用改动方，不产生冲突", () => {
    const base = { title: "旧标题", description: "旧描述" };
    const proposal = buildMergeProposal({
      base,
      server: { title: "旧标题", description: "服务端新描述" },
      client: { title: "客户端新标题", description: "旧描述" },
      serverTimestamps: { description: "2026-09-19T10:00:00.000Z" },
      clientTimestamps: { title: "2026-09-19T11:00:00.000Z" },
      baseUpdatedAt: "2026-09-19T09:00:00.000Z",
    });

    expect(proposal.conflicts).toHaveLength(0);
    expect(proposal.merged.title).toBe("客户端新标题");
    expect(proposal.merged.description).toBe("服务端新描述");
  });

  it("两端都改且不同时标记冲突，并按时间戳预选较新一方", () => {
    const base = { title: "旧标题" };
    const proposal = buildMergeProposal({
      base,
      server: { title: "服务端标题" },
      client: { title: "客户端标题" },
      serverTimestamps: { title: "2026-09-19T12:00:00.000Z" },
      clientTimestamps: { title: "2026-09-19T10:00:00.000Z" },
      baseUpdatedAt: "2026-09-19T09:00:00.000Z",
    });

    expect(proposal.conflicts).toHaveLength(1);
    expect(proposal.conflicts[0]?.field).toBe("title");
    expect(proposal.conflicts[0]?.winner).toBe("server");
    expect(proposal.merged.title).toBe("服务端标题");
  });

  it("本地时间戳更新时预选本地值", () => {
    const base = { title: "旧标题" };
    const proposal = buildMergeProposal({
      base,
      server: { title: "服务端标题" },
      client: { title: "客户端标题" },
      serverTimestamps: { title: "2026-09-19T10:00:00.000Z" },
      clientTimestamps: { title: "2026-09-19T12:00:00.000Z" },
      baseUpdatedAt: "2026-09-19T09:00:00.000Z",
    });

    expect(proposal.conflicts[0]?.winner).toBe("client");
    expect(proposal.merged.title).toBe("客户端标题");
  });

  it("两端改成相同内容不算冲突", () => {
    const base = { title: "旧标题" };
    const proposal = buildMergeProposal({
      base,
      server: { title: "同一个新标题" },
      client: { title: "同一个新标题" },
      serverTimestamps: { title: "2026-09-19T10:00:00.000Z" },
      clientTimestamps: { title: "2026-09-19T11:00:00.000Z" },
      baseUpdatedAt: "2026-09-19T09:00:00.000Z",
    });

    expect(proposal.conflicts).toHaveLength(0);
    expect(proposal.merged.title).toBe("同一个新标题");
  });

  it("属性字段按 key 独立合并：一端改属性 A、另一端改属性 B 互不冲突", () => {
    const base = { "attributes.has_backrest": false, "attributes.count": 1 };
    const proposal = buildMergeProposal({
      base,
      server: { "attributes.has_backrest": true, "attributes.count": 1 },
      client: { "attributes.has_backrest": false, "attributes.count": 4 },
      serverTimestamps: { "attributes.has_backrest": "2026-09-19T10:00:00.000Z" },
      clientTimestamps: { "attributes.count": "2026-09-19T10:00:00.000Z" },
      baseUpdatedAt: "2026-09-19T09:00:00.000Z",
    });

    expect(proposal.conflicts).toHaveLength(0);
    expect(proposal.merged["attributes.has_backrest"]).toBe(true);
    expect(proposal.merged["attributes.count"]).toBe(4);
  });

  it("数组字段顺序不同视为不同值，进入冲突而不是静默合并", () => {
    const base = { mediaUuids: ["a", "b"] };
    const proposal = buildMergeProposal({
      base,
      server: { mediaUuids: ["a", "b", "c"] },
      client: { mediaUuids: ["x", "a", "b"] },
      serverTimestamps: { mediaUuids: "2026-09-19T10:00:00.000Z" },
      clientTimestamps: { mediaUuids: "2026-09-19T11:00:00.000Z" },
      baseUpdatedAt: "2026-09-19T09:00:00.000Z",
    });

    expect(proposal.conflicts).toHaveLength(1);
    expect(proposal.conflicts[0]?.field).toBe("mediaUuids");
  });
});
