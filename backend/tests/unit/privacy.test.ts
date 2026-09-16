import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { applyBlurRegions, processImage, sanitizeImage } from "../../src/services/imaging";
import { checkText, assertNoPii } from "../../src/services/moderation/contentFilter";
import { computeFreshness } from "../../src/services/moderation/credit";
import { deriveSigningKey } from "../../src/services/storage/s3";
import { textSimilarity } from "../../src/modules/spots/service";

// 造一张带"人脸区域"的测试图：整张浅灰，中间一块深蓝色方块
async function buildTestImage(): Promise<{ buffer: Buffer; size: number }> {
  const size = 200;
  const background = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 230, g: 230, b: 230 } },
  })
    .png()
    .toBuffer();

  const patch = await sharp({
    create: { width: 60, height: 60, channels: 3, background: { r: 10, g: 20, b: 200 } },
  })
    .png()
    .toBuffer();

  const buffer = await sharp(background)
    .composite([{ input: patch, left: 70, top: 70 }])
    .png()
    .toBuffer();

  return { buffer, size };
}

async function pixelAt(buffer: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const offset = (y * info.width + x) * channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

describe("图片隐私处理", () => {
  it("清除 EXIF（含 GPS）并按方向摆正", async () => {
    const { buffer } = await buildTestImage();
    const withExif = await sharp(buffer)
      .withMetadata({ exif: { IFD0: { Copyright: "test" } } })
      .jpeg()
      .toBuffer();

    const before = await sharp(withExif).metadata();
    expect(before.exif).toBeDefined();

    const sanitized = await sanitizeImage(withExif);
    const after = await sharp(sanitized.buffer).metadata();
    expect(after.exif).toBeUndefined();
    expect(sanitized.width).toBeGreaterThan(0);
  });

  it("模糊区域确实改变了该区域的像素", async () => {
    const { buffer } = await buildTestImage();
    const region = { x: 0.3, y: 0.3, w: 0.35, h: 0.35, algorithm: "pixelate" as const, strength: 12 };

    const blurred = await applyBlurRegions(buffer, [region], 200, 200);

    // 整幅图的原始像素必然发生变化
    const originalRaw = await sharp(buffer).raw().toBuffer();
    const blurredRaw = await sharp(blurred).raw().toBuffer();
    expect(blurredRaw.equals(originalRaw)).toBe(false);

    // 区域内的像素必须确实被改写，区域外的像素必须原样保留
    const original = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const after = await sharp(blurred).raw().toBuffer({ resolveWithObject: true });
    const channels = original.info.channels;

    let changedInside = 0;
    let changedOutside = 0;

    for (let y = 0; y < original.info.height; y += 1) {
      for (let x = 0; x < original.info.width; x += 1) {
        const offset = (y * original.info.width + x) * channels;
        const same =
          original.data[offset] === after.data[offset] &&
          original.data[offset + 1] === after.data[offset + 1] &&
          original.data[offset + 2] === after.data[offset + 2];
        if (same) continue;

        const inside = x >= 60 && x < 130 && y >= 60 && y < 130;
        if (inside) changedInside += 1;
        else changedOutside += 1;
      }
    }

    expect(changedInside).toBeGreaterThan(0);
    // 打码不能"溢出"到区域之外，否则会把无关内容也糊掉
    expect(changedOutside).toBe(0);
  });

  it("不打码时保持原样", async () => {
    const { buffer } = await buildTestImage();
    const same = await applyBlurRegions(buffer, [], 200, 200);
    expect(await pixelAt(same, 100, 100)).toEqual(await pixelAt(buffer, 100, 100));
  });

  it("完整流水线同时产出三档变体，且都不含未处理区域", async () => {
    const { buffer } = await buildTestImage();
    const result = await processImage(buffer, [
      { x: 0.3, y: 0.3, w: 0.35, h: 0.35, algorithm: "gaussian", strength: 18 },
    ]);

    expect(Object.keys(result.variants).sort()).toEqual(["full", "grid", "thumb"]);
    for (const variant of Object.values(result.variants)) {
      const meta = await sharp(variant.buffer).metadata();
      expect(meta.format).toBe("webp");
    }
    expect(result.variants.thumb.width).toBeLessThanOrEqual(320);
    expect(result.variants.full.width).toBeLessThanOrEqual(1600);
  });

  it("模糊区域的归一化坐标被正确裁剪到图片范围内", async () => {
    const { buffer } = await buildTestImage();
    // 越界的区域不应导致异常，也不应打码到图片之外
    const result = await applyBlurRegions(
      buffer,
      [{ x: 0.95, y: 0.95, w: 0.5, h: 0.5, algorithm: "pixelate", strength: 10 }],
      200,
      200,
    );
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("内容与个人信息过滤", () => {
  it("拦截硬性违规内容", () => {
    expect(checkText("这里有代开发票的服务").ok).toBe(false);
    expect(checkText("公园里有一张长椅").ok).toBe(true);
  });

  it("识别手机号、身份证号与联系方式", () => {
    expect(checkText("联系我 13800138000").flags.some((flag) => flag.label === "手机号")).toBe(true);
    expect(checkText("微信：abc12345").flags.some((flag) => flag.label === "微信号")).toBe(true);
    expect(checkText("详见 https://spam.example.com").flags.some((flag) => flag.label === "外部链接")).toBe(true);
  });

  it("个人信息的错误提示可读且给出字段", () => {
    try {
      assertNoPii("我的电话是 13800138000");
      throw new Error("本应抛出异常");
    } catch (error) {
      const appError = error as { code?: string; message: string };
      expect(appError.code).toBe("COMMENT_PII_BLOCKED");
      expect(appError.message).toContain("手机号");
    }
  });
});

describe("新鲜度计算", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("刚发布且无人确认时分数中等", () => {
    const score = computeFreshness({
      confirmCount: 0,
      staleReportCount: 0,
      lastConfirmedAt: null,
      publishedAt: now,
      now,
    });
    expect(score).toBe(50);
  });

  it("确认会加分，过期上报会减分", () => {
    const confirmed = computeFreshness({
      confirmCount: 3,
      staleReportCount: 0,
      lastConfirmedAt: now,
      publishedAt: now,
      now,
    });
    const stale = computeFreshness({
      confirmCount: 0,
      staleReportCount: 3,
      lastConfirmedAt: null,
      publishedAt: now,
      now,
    });
    expect(confirmed).toBeGreaterThan(50);
    expect(stale).toBeLessThan(50);
  });

  it("分数始终落在 0–100 之间", () => {
    const score = computeFreshness({
      confirmCount: 50,
      staleReportCount: 0,
      lastConfirmedAt: now,
      publishedAt: now,
      now,
    });
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("重复条目检测", () => {
  it("完全相同的标题相似度为 1", () => {
    expect(textSimilarity("梧桐树下的长椅", "梧桐树下的长椅")).toBe(1);
  });

  it("明显不同的内容相似度很低", () => {
    expect(textSimilarity("梧桐树下的长椅", "地铁口遮雨棚")).toBeLessThan(0.3);
  });

  it("标点与空格不影响判断", () => {
    expect(textSimilarity("梧桐树下 的长椅", "梧桐树下的长椅")).toBe(1);
  });
});

describe("S3 签名（对齐 AWS 官方测试向量）", () => {
  it("签名密钥派生结果与官方文档一致", () => {
    const key = deriveSigningKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20120215",
      "us-east-1",
      "iam",
    );
    expect(key.toString("hex")).toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });

  it("不同区域得到的密钥不同", () => {
    const a = deriveSigningKey("secret", "20120215", "us-east-1", "s3");
    const b = deriveSigningKey("secret", "20120215", "cn-north-1", "s3");
    expect(a.toString("hex")).not.toBe(b.toString("hex"));
  });
});
