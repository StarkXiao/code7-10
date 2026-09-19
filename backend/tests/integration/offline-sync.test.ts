import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";

// 移动端断网补传相关：
//   1. POST /spots 带 clientKey 的重试必须幂等（同一草稿只落库一次）；
//   2. PATCH 带 baseUpdatedAt 的乐观锁：版本过期返回 409 和服务端最新内容。
let app: Express;
let token = "";
let userUuid = "";

const suffix = Date.now().toString(36);
const email = `offline-${suffix}@example.com`;
const password = "Str0ngPass1";

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  await initStorage();
  app = createApp();

  await request(app)
    .post("/api/v1/auth/register")
    .send({ email, password, nickname: `离线用户${suffix.slice(-4)}` })
    .expect(201);

  const login = await request(app).post("/api/v1/auth/login").send({ account: email, password }).expect(200);
  token = login.body.data.accessToken;

  const me = await request(app).get("/api/v1/auth/me").set(auth()).expect(200);
  userUuid = me.body.data.user.uuid;
}, 60000);

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { uuid: userUuid }, select: { id: true } });
  const ids = users.map((record) => record.id);
  if (ids.length > 0) {
    await prisma.clientSpotCreate.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}, 60000);

describe("断网补传幂等", () => {
  it("同一 clientKey 的重复创建只产生一条草稿", async () => {
    const clientKey = `key-${suffix}-1`;
    const payload = {
      clientKey,
      categoryCode: "bench",
      title: "幂等测试长椅",
      description: "第一次请求",
      attributes: {},
      lat: 30.2,
      lng: 120.2,
    };

    const first = await request(app).post("/api/v1/spots").set(auth()).send(payload).expect(201);
    const second = await request(app)
      .post("/api/v1/spots")
      .set(auth())
      .send({ ...payload, description: "重试请求，应被忽略" })
      .expect(201);

    expect(second.body.data.uuid).toBe(first.body.data.uuid);
    // 幂等命中时返回的是首次创建的内容
    expect(second.body.data.description).toBe("第一次请求");

    const ownerIds = (
      await prisma.user.findMany({ where: { uuid: userUuid }, select: { id: true } })
    ).map((record) => record.id);
    const count = await prisma.spot.count({
      where: { ownerId: { in: ownerIds }, title: "幂等测试长椅" },
    });
    expect(count).toBe(1);
  }, 30000);
});

describe("乐观锁与多端冲突", () => {
  it("baseUpdatedAt 过期时 PATCH 返回 409 和服务端最新内容", async () => {
    const created = await request(app)
      .post("/api/v1/spots")
      .set(auth())
      .send({
        clientKey: `key-${suffix}-2`,
        categoryCode: "bench",
        title: "冲突测试长椅",
        attributes: {},
        lat: 30.3,
        lng: 120.3,
      })
      .expect(201);

    const uuid = created.body.data.uuid;
    const originalUpdatedAt = created.body.data.updatedAt;

    // 另一台设备先改成功
    await request(app)
      .patch(`/api/v1/spots/${uuid}`)
      .set(auth())
      .send({ title: "另一台设备改的标题" })
      .expect(200);

    // 本机拿着旧版本号补传
    const stale = await request(app)
      .patch(`/api/v1/spots/${uuid}`)
      .set(auth())
      .send({ title: "本机离线改的标题", baseUpdatedAt: originalUpdatedAt })
      .expect(409);

    expect(stale.body.success).toBe(false);
    expect(stale.body.error.code).toBe("SPOT_VERSION_CONFLICT");
    expect(stale.body.error.details.current.title).toBe("另一台设备改的标题");
    expect(stale.body.error.details.current.updatedAt).not.toBe(originalUpdatedAt);
  }, 30000);

  it("baseUpdatedAt 与服务端一致时 PATCH 正常通过", async () => {
    const created = await request(app)
      .post("/api/v1/spots")
      .set(auth())
      .send({
        clientKey: `key-${suffix}-3`,
        categoryCode: "bench",
        title: "版本一致测试",
        attributes: {},
        lat: 30.4,
        lng: 120.4,
      })
      .expect(201);

    const uuid = created.body.data.uuid;
    const updated = await request(app)
      .patch(`/api/v1/spots/${uuid}`)
      .set(auth())
      .send({ title: "带版本号的修改", baseUpdatedAt: created.body.data.updatedAt })
      .expect(200);

    expect(updated.body.data.title).toBe("带版本号的修改");
  }, 30000);

  it("不带 baseUpdatedAt 的旧客户端行为不受影响", async () => {
    const list = await request(app).get("/api/v1/me/spots").set(auth()).expect(200);
    const target = list.body.data.items[0];

    await request(app)
      .patch(`/api/v1/spots/${target.uuid}`)
      .set(auth())
      .send({ title: "老客户端直接覆盖" })
      .expect(200);
  }, 30000);
});
