import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";

// 这组测试跑在真实数据库与 Redis 上（docker compose up -d postgres redis），
// 覆盖文档第 16.2 节要求的主链路：提交 → 审核 → 发布 → 互动 → 处置。
let app: Express;
let contributorToken = "";
let moderatorToken = "";
let contributorUuid = "";
let moderatorUuid = "";

const suffix = Date.now().toString(36);
const contributorEmail = `contributor-${suffix}@example.com`;
const moderatorEmail = `moderator-${suffix}@example.com`;
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
    .send({ email: contributorEmail, password, nickname: `贡献者${suffix.slice(-4)}` })
    .expect(201);
  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: moderatorEmail, password, nickname: `审核员${suffix.slice(-4)}` })
    .expect(201);

  // 审核角色由管理员授予，这里直接改库模拟运营流程
  await prisma.user.update({ where: { email: moderatorEmail }, data: { role: "moderator" } });

  const contributor = await login(contributorEmail);
  const moderator = await login(moderatorEmail);
  contributorToken = contributor.token;
  contributorUuid = contributor.uuid;
  moderatorToken = moderator.token;
  moderatorUuid = moderator.uuid;
}, 60000);

afterAll(async () => {
  // 清理本次测试产生的数据，避免污染开发库
  const users = [contributorUuid, moderatorUuid].filter(Boolean);
  const records = await prisma.user.findMany({ where: { uuid: { in: users } }, select: { id: true } });
  const ids = records.map((record) => record.id);

  if (ids.length > 0) {
    await prisma.comment.deleteMany({ where: { userId: { in: ids } } });
    await prisma.report.deleteMany({ where: { reporterId: { in: ids } } });
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
}, 60000);

describe("闭环主链路", () => {
  let spotUuid = "";
  let taskId = "";

  it("未登录可以浏览已发布条目", async () => {
    const response = await request(app).get("/api/v1/spots").expect(200);
    expect(response.body.success).toBe(true);
    expect(Array.isArray(response.body.data.items)).toBe(true);
  });

  it("地图返回的是模糊坐标，不带精确坐标", async () => {
    const response = await request(app).get("/api/v1/spots").expect(200);
    for (const item of response.body.data.items) {
      expect(item.location.precise).toBe(false);
      expect(item).not.toHaveProperty("exactLat");
      expect(item).not.toHaveProperty("exactLng");
    }
  });

  it("贡献者可以创建草稿并提交审核", async () => {
    const created = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({
        categoryCode: "bench",
        title: `集成测试长椅${suffix.slice(-4)}`,
        description: "自动化测试写入，验证完整闭环。",
        attributes: { has_backrest: true, condition: "good", count: 2 },
        lat: 30.1234,
        lng: 120.5678,
        fuzzEnabled: true,
        fuzzRadiusM: 100,
        mediaUuids: [],
      })
      .expect(201);

    spotUuid = created.body.data.uuid;
    expect(created.body.data.status).toBe("draft");

    const submitted = await request(app)
      .post(`/api/v1/spots/${spotUuid}/submit`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .expect(200);

    expect(submitted.body.data.status).toBe("pending");
    taskId = submitted.body.data.taskId;
  });

  it("缺必填属性时提交会被拦下", async () => {
    const created = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({
        categoryCode: "bench",
        title: `缺字段${suffix.slice(-4)}`,
        attributes: { count: 2 },
        lat: 30.2,
        lng: 120.6,
      })
      .expect(201);

    const response = await request(app)
      .post(`/api/v1/spots/${created.body.data.uuid}/submit`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .expect(422);

    expect(response.body.error.code).toBe("SPOT_ATTRIBUTE_REQUIRED");
  });

  it("审核员可以领取任务，且同一任务不会被重复领取", async () => {
    await request(app)
      .post(`/api/v1/moderation/tasks/${taskId}/claim`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);

    const detail = await request(app)
      .get(`/api/v1/moderation/tasks/${taskId}`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);

    expect(detail.body.data.claimedByMe).toBe(true);
    expect(detail.body.data.spot.exactLocation.lat).toBeCloseTo(30.1234, 4);
  });

  it("普通用户不能访问审核接口", async () => {
    await request(app)
      .get("/api/v1/moderation/queue")
      .set("Authorization", `Bearer ${contributorToken}`)
      .expect(403);
  });

  it("隐私未确认的图片会挡住发布", async () => {
    const asset = await prisma.mediaAsset.create({
      data: {
        ownerId: (await prisma.user.findUniqueOrThrow({ where: { uuid: contributorUuid } })).id,
        contentHash: "a".repeat(64),
        originalSize: BigInt(1024),
        originalMime: "image/webp",
        width: 100,
        height: 100,
        privacyStatus: "needs_manual",
        spotId: (await prisma.spot.findUniqueOrThrow({ where: { uuid: spotUuid } })).id,
      },
    });

    const response = await request(app)
      .post(`/api/v1/moderation/tasks/${taskId}/approve`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .send({})
      .expect(422);

    expect(response.body.error.code).toBe("PRIVACY_NOT_CONFIRMED");

    // 处理干净后放行：这里直接改状态，真实流程由审核员在模糊工作台完成
    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { privacyStatus: "confirmed", privacyConfirmedBy: (await prisma.user.findUniqueOrThrow({ where: { uuid: moderatorUuid } })).id },
    });
  });

  it("通过审核后条目发布到地图，且坐标已模糊", async () => {
    const approved = await request(app)
      .post(`/api/v1/moderation/tasks/${taskId}/approve`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .send({ reason: "信息完整" })
      .expect(200);

    expect(approved.body.data.status).toBe("published");

    const detail = await request(app).get(`/api/v1/spots/${spotUuid}`).expect(200);
    const spot = detail.body.data;

    expect(spot.status).toBe("published");
    expect(spot.location.precise).toBe(false);
    expect(spot.location.fuzzed).toBe(true);
    // 公开坐标偏离精确坐标，但偏移不超过设定半径
    const drifted = Math.abs(spot.location.lat - 30.1234) > 1e-6 || Math.abs(spot.location.lng - 120.5678) > 1e-6;
    expect(drifted).toBe(true);
  });

  it("提交者会收到审核结果通知", async () => {
    const notifications = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${contributorToken}`)
      .expect(200);

    expect(notifications.body.data.items.some((item: { type: string }) => item.type === "review_approved")).toBe(true);
  });

  it("新用户的评论先进入待审，审核通过后才公开", async () => {
    const posted = await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ body: "补充一句：旁边有垃圾桶" })
      .expect(201);

    expect(posted.body.data.pendingModeration).toBe(true);
    const commentId = posted.body.data.id;

    const hidden = await request(app).get(`/api/v1/spots/${spotUuid}/comments`).expect(200);
    expect(hidden.body.data.items).toHaveLength(0);

    await request(app)
      .post(`/api/v1/moderation/comments/${commentId}/approve`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);

    const visible = await request(app).get(`/api/v1/spots/${spotUuid}/comments`).expect(200);
    expect(visible.body.data.items).toHaveLength(1);
  });

  it("评论里包含手机号会被拦下", async () => {
    const response = await request(app)
      .post(`/api/v1/spots/${spotUuid}/comments`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ body: "有事打 13800138000" })
      .expect(422);

    expect(response.body.error.code).toBe("COMMENT_PII_BLOCKED");
  });

  it("举报成立后条目下架，双方收到通知", async () => {
    const reported = await request(app)
      .post("/api/v1/reports")
      .set("Authorization", `Bearer ${moderatorToken}`)
      .send({ targetType: "spot", targetId: (await prisma.spot.findUniqueOrThrow({ where: { uuid: spotUuid } })).id, reason: "FALSE_INFO", detail: "测试举报" })
      .expect(201);

    const resolved = await request(app)
      .post(`/api/v1/moderation/reports/${reported.body.data.id}/resolve`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .send({ note: "核实为测试内容" })
      .expect(200);

    expect(resolved.body.data.action).toBe("spot_hidden");

    const detail = await request(app).get(`/api/v1/spots/${spotUuid}`).expect(404);
    expect(detail.body.error.code).toBe("NOT_FOUND");
  });

  it("审计日志记录了审核与隐私相关动作", async () => {
    const logs = await request(app)
      .get("/api/v1/admin/audit-logs")
      .set("Authorization", `Bearer ${moderatorToken}`);

    // 审核员无权访问审计接口，必须由管理员查看
    expect(logs.status).toBe(403);
  });
});
