import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";

// 移动端离线补传：幂等创建 + 乐观并发 + 时间戳冲突合并。
// 跑在真实数据库与 Redis 上（docker compose up -d postgres redis）。
let app: Express;
let token = "";
let userUuid = "";

const suffix = Date.now().toString(36);
const email = `offline-${suffix}@example.com`;
const password = "Str0ngPass1";

async function login(account: string): Promise<{ token: string; uuid: string }> {
  const response = await request(app).post("/api/v1/auth/login").send({ account, password }).expect(200);
  const me = await request(app)
    .get("/api/v1/auth/me")
    .set("Authorization", `Bearer ${response.body.data.accessToken}`)
    .expect(200);
  return { token: response.body.data.accessToken, uuid: me.body.data.user.uuid };
}

beforeAll(async () => {
  await initStorage();
  app = createApp();
  await request(app)
    .post("/api/v1/auth/register")
    .send({ email, password, nickname: `离线用户${suffix.slice(-4)}` })
    .expect(201);
  const result = await login(email);
  token = result.token;
  userUuid = result.uuid;
}, 60000);

afterAll(async () => {
  const users = [userUuid].filter(Boolean);
  const records = await prisma.user.findMany({ where: { uuid: { in: users } }, select: { id: true } });
  const ids = records.map((record) => record.id);
  if (ids.length > 0) {
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.idempotencyKey.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}, 60000);

describe("离线补传与多端合并", () => {
  it("同一 Idempotency-Key 重复创建只产生一条草稿，返回首次结果", async () => {
    const idemKey = `draft-${suffix}`;
    const payload = {
      categoryCode: "bench",
      title: `离线草稿${suffix.slice(-4)}`,
      description: "断网时写的，联网后补传",
      attributes: { has_backrest: true, condition: "good" },
      lat: 30.2,
      lng: 121.4,
      fieldTimestamps: {
        title: "2026-09-19T08:00:00.000Z",
        "attributes.has_backrest": "2026-09-19T08:00:00.000Z",
      },
    };

    const first = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey)
      .send(payload)
      .expect(201);

    const second = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey)
      .send(payload)
      .expect(201);

    expect(second.body.data.uuid).toBe(first.body.data.uuid);

    const count = await prisma.spot.count({ where: { title: payload.title } });
    expect(count).toBe(1);
  });

  it("同键不同体返回 422", async () => {
    await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `clash-${suffix}`)
      .send({ categoryCode: "bench", title: "第一次的标题内容", lat: 30.2, lng: 121.4 })
      .expect(201);

    const response = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `clash-${suffix}`)
      .send({ categoryCode: "bench", title: "第二次换成别的内容", lat: 30.2, lng: 121.4 })
      .expect(422);

    expect(response.body.error.code).toBe("IDEMPOTENCY_REPLAY_MISMATCH");
  });

  it("基线版本落后时 PATCH 返回 409 并给出按时间戳预选的合并方案", async () => {
    const created = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${token}`)
      .send({ categoryCode: "bench", title: "合并测试原始标题", lat: 30.2, lng: 121.4 })
      .expect(201);
    const spotUuid = created.body.data.uuid as string;
    const baseUpdatedAt = created.body.data.updatedAt as string;

    // 模拟"另一台设备（或服务端）"先改了标题
    await new Promise((resolve) => setTimeout(resolve, 5));
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "服务端已经改成这个" })
      .expect(200);

    // 离线端拿着旧基线补传，改的是描述
    const conflict = await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        baseUpdatedAt,
        description: "离线端补的描述",
        fieldTimestamps: { description: "2026-09-19T09:00:00.000Z" },
      })
      .expect(409);

    expect(conflict.body.error.code).toBe("SPOT_VERSION_CONFLICT");
    const proposal = conflict.body.error.details.proposal;
    // 只有离线端改了描述，服务端没动 → 不是冲突，直接进合并建议
    expect(proposal.merged.description).toBe("离线端补的描述");
    // 标题离线端没动，合并建议保持服务端的新值
    expect(proposal.merged.title).toBe("服务端已经改成这个");
  });

  it("两端改同一字段时 409 中标记冲突，用户确认后经 /merge 入库", async () => {
    const created = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${token}`)
      .send({
        categoryCode: "bench",
        title: "同字段冲突",
        attributes: { has_backrest: false, count: 1 },
        lat: 30.2,
        lng: 121.4,
      })
      .expect(201);
    const spotUuid = created.body.data.uuid as string;
    const baseUpdatedAt = created.body.data.updatedAt as string;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ attributes: { has_backrest: true, count: 1 } })
      .expect(200);

    const latest = await request(app).get(`/api/v1/spots/${spotUuid}`).set("Authorization", `Bearer ${token}`);
    const serverUpdatedAt = latest.body.data.updatedAt;

    // 离线端在同一属性上改成另一个值，且本地时间戳更新
    const conflict = await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        baseUpdatedAt,
        attributes: { has_backrest: false, count: 2 },
        fieldTimestamps: {
          "attributes.has_backrest": "2026-09-20T09:00:00.000Z",
          "attributes.count": "2026-09-20T09:00:00.000Z",
        },
      })
      .expect(409);

    const proposal = conflict.body.error.details.proposal;
    const conflictFields = proposal.conflicts.map((item: { field: string }) => item.field);
    expect(conflictFields).toContain("attributes.has_backrest");
    expect(conflictFields).toContain("attributes.count");

    // 用户在对话框里确认最终结果：靠背采纳服务端（true），人数采纳离线端（2）。
    // 确认字段以展平形式提交（attributes.has_backrest / attributes.count），
    // 服务端按 key 合并进既有属性对象。
    const confirmed = await request(app)
      .post(`/api/v1/spots/${spotUuid}/merge`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `merge-${suffix}-${spotUuid.slice(0, 8)}`)
      .send({
        baseUpdatedAt: serverUpdatedAt,
        fields: {
          title: "同字段冲突",
          "attributes.has_backrest": true,
          "attributes.count": 2,
        },
        fieldTimestamps: {
          title: "2026-09-20T10:00:00.000Z",
          "attributes.has_backrest": "2026-09-20T10:00:00.000Z",
          "attributes.count": "2026-09-20T10:00:00.000Z",
        },
      })
      .expect(200);

    expect(confirmed.body.data.title).toBe("同字段冲突");
    expect(confirmed.body.data.attributes.has_backrest).toBe(true);
    expect(confirmed.body.data.attributes.count).toBe(2);

    // merge 也要幂等：同键重试不报错、不产生第二条修订
    const replay = await request(app)
      .post(`/api/v1/spots/${spotUuid}/merge`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `merge-${suffix}-${spotUuid.slice(0, 8)}`)
      .send({
        baseUpdatedAt: serverUpdatedAt,
        fields: {
          title: "同字段冲突",
          "attributes.has_backrest": true,
          "attributes.count": 2,
        },
        fieldTimestamps: {
          title: "2026-09-20T10:00:00.000Z",
          "attributes.has_backrest": "2026-09-20T10:00:00.000Z",
          "attributes.count": "2026-09-20T10:00:00.000Z",
        },
      })
      .expect(200);
    expect(replay.body.data.attributes.count).toBe(2);
  });

  it("按属性 key 合并不会冲掉未参与确认的其他属性", async () => {
    const created = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${token}`)
      .send({
        categoryCode: "bench",
        title: "属性局部合并",
        attributes: { has_backrest: false, condition: "good", shade: "full" },
        lat: 30.2,
        lng: 121.4,
      })
      .expect(201);
    const spotUuid = created.body.data.uuid as string;
    const baseUpdatedAt = created.body.data.updatedAt as string;

    await new Promise((resolve) => setTimeout(resolve, 5));
    // 服务端先改了 has_backrest
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ attributes: { has_backrest: true, condition: "good", shade: "full" } })
      .expect(200);

    const latest = await request(app).get(`/api/v1/spots/${spotUuid}`).set("Authorization", `Bearer ${token}`);
    // 离线端只确认 has_backrest（采纳服务端值），没碰 condition / shade
    await request(app)
      .post(`/api/v1/spots/${spotUuid}/merge`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        baseUpdatedAt: latest.body.data.updatedAt,
        fields: { "attributes.has_backrest": true },
        fieldTimestamps: { "attributes.has_backrest": "2026-09-20T10:00:00.000Z" },
      })
      .expect(200);

    const after = await request(app).get(`/api/v1/spots/${spotUuid}`).set("Authorization", `Bearer ${token}`);
    expect(after.body.data.attributes.has_backrest).toBe(true);
    expect(after.body.data.attributes.condition).toBe("good");
    expect(after.body.data.attributes.shade).toBe("full");
  });

  it("merge 的基线版本再次落后时返回 409，不覆盖最新内容", async () => {
    const created = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${token}`)
      .send({ categoryCode: "bench", title: "合并竞态", lat: 30.2, lng: 121.4 })
      .expect(201);
    const spotUuid = created.body.data.uuid as string;
    const staleBase = created.body.data.updatedAt as string;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "确认期间又被改了" })
      .expect(200);

    const response = await request(app)
      .post(`/api/v1/spots/${spotUuid}/merge`)
      .set("Authorization", `Bearer ${token}`)
      .send({ baseUpdatedAt: staleBase, fields: { title: "用户确认的旧版本" }, fieldTimestamps: {} })
      .expect(409);

    expect(response.body.error.code).toBe("SPOT_VERSION_CONFLICT");
  });

  it("GET 详情对作者返回字段时间戳", async () => {
    const created = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${token}`)
      .send({
        categoryCode: "bench",
        title: "时间戳回传",
        lat: 30.2,
        lng: 121.4,
        fieldTimestamps: { title: "2026-09-19T08:00:00.000Z" },
      })
      .expect(201);

    const detail = await request(app)
      .get(`/api/v1/spots/${created.body.data.uuid}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(detail.body.data.fieldTimestamps.title).toBe("2026-09-19T08:00:00.000Z");
    expect(detail.body.data.fieldTimestamps.lat).toBeTruthy();
  });
});
