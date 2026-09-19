import { describe, expect, it } from "vitest";
import { mergeByTimestamp, spotToDraftPayload } from "@/offline/merge";
import type { FieldTimestamps, SpotDraftPayload } from "@/offline/merge";

const T0 = 1_700_000_000_000;
const T_REMOTE = T0 + 10_000;
const T_LOCAL = T0 + 20_000;

function baseRemote(): SpotDraftPayload {
  return {
    categoryCode: "bench",
    title: "服务端标题",
    description: "服务端描述",
    attributes: { has_backrest: true },
    lat: 30.1,
    lng: 120.1,
    fuzzEnabled: true,
    fuzzRadiusM: 50,
    mediaUuids: ["11111111-1111-4111-8111-111111111111"],
  };
}

function localFrom(remote: SpotDraftPayload, overrides: Partial<SpotDraftPayload> = {}): SpotDraftPayload {
  return { ...remote, ...overrides };
}

describe("mergeByTimestamp", () => {
  it("两端内容一致时不产生冲突", () => {
    const remote = baseRemote();
    const local = localFrom(remote);
    const times: FieldTimestamps = {
      title: T_LOCAL,
      description: T_LOCAL,
    };
    const result = mergeByTimestamp(local, times, remote, T_REMOTE, { title: T0, description: T0 });
    expect(result.hasConflict).toBe(false);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged.title).toBe("服务端标题");
  });

  it("本机修改更新时采用本机值，但仍要求用户确认该字段", () => {
    const remote = baseRemote();
    const local = localFrom(remote, { title: "本机新标题" });
    const result = mergeByTimestamp(
      local,
      { title: T_LOCAL },
      remote,
      T_REMOTE,
      { title: T0 },
    );
    expect(result.hasConflict).toBe(true);
    const titleConflict = result.conflicts.find((c) => c.field === "title");
    expect(titleConflict?.winner).toBe("local");
    expect(result.merged.title).toBe("本机新标题");
  });

  it("其他设备修改更新时建议服务端值", () => {
    const remote = baseRemote();
    const local = localFrom(remote, { title: "本机标题" });
    const result = mergeByTimestamp(
      local,
      { title: T_LOCAL - 30_000 }, // 本机改得更早
      { ...remote, title: "其他设备的新标题" },
      T_REMOTE,
      { title: T0 },
    );
    const titleConflict = result.conflicts.find((c) => c.field === "title");
    expect(titleConflict?.winner).toBe("remote");
    expect(result.merged.title).toBe("其他设备的新标题");
  });

  it("本机没动过的字段保留服务端值，编辑期内被别处改动时提示确认", () => {
    const remote = baseRemote();
    const local = localFrom(remote, { title: "本机标题" });
    // localTimes 里没有 description：本机未编辑描述；基线说明用户打开页面时见过该字段
    const result = mergeByTimestamp(local, { title: T_LOCAL }, remote, T_REMOTE, {
      title: T0,
      description: T0,
    });
    expect(result.merged.description).toBe("服务端描述");
    expect(result.conflicts.some((c) => c.field === "description")).toBe(true);
  });

  it("新建草稿（无基线）时本机没碰过的字段不产生误报", () => {
    const remote = baseRemote();
    const local = localFrom(remote, { title: "本机标题" });
    const result = mergeByTimestamp(local, { title: T_LOCAL }, remote, T_REMOTE, {});
    expect(result.merged.description).toBe("服务端描述");
    expect(result.conflicts.some((c) => c.field === "description")).toBe(false);
  });

  it("远端自基线以来未变化的标量字段直接用本机值，不打扰用户", () => {
    const remote = baseRemote();
    const local = localFrom(remote, { title: "本机标题" });
    // 基线时间 == 远端更新时间：远端没动过
    const result = mergeByTimestamp(local, { title: T_LOCAL }, remote, T_REMOTE, {
      title: T_REMOTE,
    });
    expect(result.merged.title).toBe("本机标题");
    expect(result.conflicts.some((c) => c.field === "title")).toBe(false);
  });

  it("attributes 即使远端没动也标记为冲突（复合字段保守处理）", () => {
    const remote = baseRemote();
    const local = localFrom(remote, { attributes: { has_backrest: false } });
    const result = mergeByTimestamp(
      local,
      { attributes: T_LOCAL },
      remote,
      T_REMOTE,
      { attributes: T_REMOTE },
    );
    expect(result.conflicts.some((c) => c.field === "attributes")).toBe(true);
  });

  it("照片列表不同始终要求用户确认", () => {
    const remote = baseRemote();
    const local = localFrom(remote, {
      mediaUuids: ["22222222-2222-4222-8222-222222222222"],
    });
    const result = mergeByTimestamp(
      local,
      { mediaUuids: T_LOCAL },
      remote,
      T_REMOTE,
      { mediaUuids: T_REMOTE },
    );
    expect(result.conflicts.some((c) => c.field === "mediaUuids")).toBe(true);
  });

  it("平局时间戳倾向本机值", () => {
    const remote = baseRemote();
    const local = localFrom(remote, { title: "本机标题" });
    const result = mergeByTimestamp(local, { title: T_REMOTE }, remote, T_REMOTE, { title: T0 });
    expect(result.conflicts.find((c) => c.field === "title")?.winner).toBe("local");
  });

  it("spotToDraftPayload 正确转换服务端条目形态", () => {
    const payload = spotToDraftPayload({
      category: { code: "bench" },
      title: "标题",
      description: null,
      attributes: { a: 1 },
      location: { lat: 30.1, lng: 120.2, fuzzed: true, radiusMeters: 100 },
      media: [{ uuid: "uuid-1" }],
    });
    expect(payload).toMatchObject({
      categoryCode: "bench",
      description: "",
      attributes: { a: 1 },
      lat: 30.1,
      lng: 120.2,
      fuzzEnabled: true,
      fuzzRadiusM: 100,
      mediaUuids: ["uuid-1"],
    });
  });
});
