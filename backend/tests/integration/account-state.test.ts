import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";

// 账号状态相关的边界：禁言到期、多标签页刷新令牌、转人工复核的信用分。
// 这几条都属于"不测就一定会悄悄坏掉"的行为。
let app: Express;
let adminToken = "";
let userToken = "";
let userUuid = "";
let userId = 0n;

const suffix = Date.now().toString(36);
const userEmail = `state-user-${suffix}@example.com`;
const adminEmail = `state-admin-${suffix}@example.com`;
const password = "Str0ngPass1";

beforeAll(async () => {
  await initStorage();
  app = createApp();

  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: userEmail, password, nickname: `状态测试${suffix.slice(-4)}` })
    .expect(201);
  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: adminEmail, password, nickname: `状态管理员${suffix.slice(-4)}` })
    .expect(201);

  await prisma.user.update({ where: { email: adminEmail }, data: { role: "admin" } });

  const userLogin = await request(app).post("/api/v1/auth/login").send({ account: userEmail, password }).expect(200);
  userToken = userLogin.body.data.accessToken;

  const adminLogin = await request(app).post("/api/v1/auth/login").send({ account: adminEmail, password }).expect(200);
  adminToken = adminLogin.body.data.accessToken;

  const record = await prisma.user.findUniqueOrThrow({ where: { email: userEmail } });
  userId = record.id;
  userUuid = record.uuid;
}, 60000);

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { in: [userEmail, adminEmail] } },
    select: { id: true },
  });
  const ids = users.map((item) => item.id);

  if (ids.length > 0) {
    await prisma.comment.deleteMany({ where: { userId: { in: ids } } });
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}, 60000);

describe("禁言到期", () => {
  it("禁言到期后用户自动恢复发言权限，不会变成永久禁言", async () => {
    // 先设一个已经过期的禁言，模拟"时间已经过去"
    await prisma.user.update({
      where: { id: userId },
      data: { status: "muted", mutedUntil: new Date(Date.now() - 60_000) },
    });

    const response = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        categoryCode: "bench",
        title: `禁言到期测试${suffix.slice(-4)}`,
        attributes: { has_backrest: true, condition: "good" },
        lat: 30.31,
        lng: 120.31,
      });

    expect(response.status).toBe(201);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.status).toBe("active");
    expect(after.mutedUntil).toBeNull();
  });

  it("禁言未到期时仍然不能发布内容", async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { status: "muted", mutedUntil: new Date(Date.now() + 3600_000) },
    });

    const response = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        categoryCode: "bench",
        title: `禁言中测试${suffix.slice(-4)}`,
        attributes: { has_backrest: true, condition: "good" },
        lat: 30.32,
        lng: 120.32,
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ACCOUNT_MUTED");

    await prisma.user.update({
      where: { id: userId },
      data: { status: "active", mutedUntil: null },
    });
  });
});

describe("刷新令牌轮换", () => {
  it("同一个令牌在宽限期内被第二个标签页重用时不会被踢下线", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ account: userEmail, password })
      .expect(200);

    const cookie = login.headers["set-cookie"];
    const cookies = Array.isArray(cookie) ? cookie : [cookie];

    // 第一个标签页刷新
    const first = await request(app).post("/api/v1/auth/refresh").set("Cookie", cookies).expect(200);
    expect(first.body.data.accessToken).toBeTruthy();

    // 第二个标签页拿着同一个旧令牌刷新，应同样成功而不是 401
    const second = await request(app).post("/api/v1/auth/refresh").set("Cookie", cookies).expect(200);
    expect(second.body.data.accessToken).toBeTruthy();
  });

  it("登出后的令牌即使还在宽限期内也必须立即失效", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ account: userEmail, password })
      .expect(200);

    const raw = login.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? raw : [raw];

    await request(app).post("/api/v1/auth/logout").set("Cookie", cookies).expect(200);
    await request(app).post("/api/v1/auth/refresh").set("Cookie", cookies).expect(401);
  });
});

describe("自动预检与信用分", () => {
  it("无视自动预检转人工复核会扣信用分", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const duplicateTitle = `同一张长椅被重复提交${suffix.slice(-4)}`;

    // 第一条正常提交，会进入待审
    const firstSpot = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        categoryCode: "bench",
        title: duplicateTitle,
        attributes: { has_backrest: true, condition: "good" },
        lat: 30.41,
        lng: 120.41,
      })
      .expect(201);

    await request(app)
      .post(`/api/v1/spots/${firstSpot.body.data.uuid}/submit`)
      .set("Authorization", `Bearer ${userToken}`)
      .expect(200);

    // 第二条同分类、同标题、同一位置，应被重复检测拦下
    const secondSpot = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        categoryCode: "bench",
        title: duplicateTitle,
        attributes: { has_backrest: true, condition: "good" },
        lat: 30.41,
        lng: 120.41,
      })
      .expect(201);

    const duplicated = await request(app)
      .post(`/api/v1/spots/${secondSpot.body.data.uuid}/submit`)
      .set("Authorization", `Bearer ${userToken}`);

    expect(duplicated.status).toBe(202);
    expect(duplicated.body.data.status).toBe("auto_rejected");
    expect(duplicated.body.data.canRequestManualReview).toBe(true);
    expect(
      duplicated.body.data.autoCheck.issues.some(
        (issue: { code: string }) => issue.code === "DUPLICATE_SUSPECTED",
      ),
    ).toBe(true);

    const afterReject = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(afterReject.creditScore).toBe(before.creditScore);

    // 用户坚持转人工复核
    await request(app)
      .post(`/api/v1/spots/${secondSpot.body.data.uuid}/request-manual-review`)
      .set("Authorization", `Bearer ${userToken}`)
      .expect(200);

    const afterOverride = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(afterOverride.creditScore).toBeLessThan(before.creditScore);
  });
});

describe("管理员权限边界", () => {
  it("普通用户访问管理接口被拒绝", async () => {
    await request(app).get("/api/v1/admin/dashboard").set("Authorization", `Bearer ${userToken}`).expect(403);
    await request(app)
      .patch(`/api/v1/admin/users/${userUuid}/role`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ role: "admin" })
      .expect(403);
  });

  it("管理员不能修改自己的角色", async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
    const response = await request(app)
      .patch(`/api/v1/admin/users/${admin.uuid}/role`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "user" });

    expect(response.status).toBe(400);
  });
});
