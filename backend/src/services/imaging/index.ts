import crypto from "node:crypto";
import sharp from "sharp";
import { IMAGE_VARIANTS, type ImageVariant } from "../../config/constants";
import { env } from "../../config/env";
import { AppError } from "../../utils/errors";
import { ERROR_CODES } from "../../config/constants";

const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp", "gif", "tiff", "avif"]);
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff", "image/avif"]);

export interface ImageProbe {
  width: number;
  height: number;
  format: string;
}

export interface BlurRegionInput {
  x: number;
  y: number;
  w: number;
  h: number;
  algorithm: "pixelate" | "gaussian";
  strength: number;
}

/**
 * 校验真实文件类型。
 * 只看 MIME 头是不够的——攻击者可以把任意内容伪装成 image/png，
 * 所以这里同时校验扩展名与 sharp 解析出的真实格式。
 */
export async function probeImage(buffer: Buffer, declaredMime: string): Promise<ImageProbe> {
  if (!ALLOWED_MIME.has(declaredMime)) {
    throw new AppError(415, ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, `不支持的图片类型：${declaredMime}`);
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer, { failOn: "error" }).metadata();
  } catch {
    throw new AppError(415, ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, "文件不是有效的图片，或已损坏");
  }

  const format = metadata.format ?? "";
  if (!ALLOWED_FORMATS.has(format)) {
    throw new AppError(415, ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, `不支持的图片格式：${format || "未知"}`);
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 1 || height < 1) {
    throw AppError.badRequest("无法读取图片尺寸");
  }
  if (Math.max(width, height) > env.IMAGE_MAX_DIMENSION) {
    throw AppError.badRequest(`图片尺寸超过限制（最长边不超过 ${env.IMAGE_MAX_DIMENSION}px）`);
  }

  return { width, height, format };
}

export function contentHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * 清除全部元数据（EXIF / GPS / ICC / XMP）并按 EXIF 方向自动旋转。
 *
 * sharp 在未显式调用 withMetadata() 时会丢弃元数据，这里借此实现"强制清洗"。
 * 这是隐私保护的第一道防线：贡献者手机拍摄的 GPS 坐标绝不能外泄。
 */
export async function sanitizeImage(buffer: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
  try {
    const pipeline = sharp(buffer, { failOn: "error", animated: false }).rotate();
    const { data, info } = await pipeline.webp({ quality: 95, effort: 4 }).toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch (error) {
    throw new AppError(
      500,
      ERROR_CODES.INTERNAL_ERROR,
      `图片元数据清洗失败：${(error as Error).message}`,
    );
  }
}

function clampRegion(region: BlurRegionInput, width: number, height: number) {
  const left = Math.max(0, Math.min(width - 1, Math.round(region.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(region.y * height)));
  const regionWidth = Math.max(1, Math.min(width - left, Math.round(region.w * width)));
  const regionHeight = Math.max(1, Math.min(height - top, Math.round(region.h * height)));
  return { left, top, width: regionWidth, height: regionHeight };
}

/**
 * 在原始分辨率上应用模糊区域。
 *
 * 先在高分辨率上打码再缩小，可以保证缩略图里也不会残留清晰细节；
 * 反之（先缩小再打码）会让大图与缩略图的马赛克范围不一致，留下泄漏窗口。
 */
export async function applyBlurRegions(
  cleanBuffer: Buffer,
  regions: BlurRegionInput[],
  width: number,
  height: number,
): Promise<Buffer> {
  if (regions.length === 0) return cleanBuffer;

  let working = cleanBuffer;

  for (const region of regions) {
    const box = clampRegion(region, width, height);
    if (box.width < 2 || box.height < 2) continue;

    const patch = await sharp(working)
      .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
      .toBuffer();

    let processed: Buffer;
    if (region.algorithm === "gaussian") {
      // sigma 与像素块大小同量级，保证模糊强度可感知
      processed = await sharp(patch)
        .blur(Math.max(1, region.strength / 3))
        .toBuffer();
    } else {
      const block = Math.max(4, region.strength);
      const smallW = Math.max(1, Math.round(box.width / block));
      const smallH = Math.max(1, Math.round(box.height / block));

      // sharp 每条流水线只允许一次 resize（后一次会覆盖前一次），
      // 所以必须先降采样成小图、再单独把小图放大回原尺寸。
      // 写成 .resize(a).resize(b) 的话，马赛克会变成空操作。
      //
      // 降采样用 cubic（区块取平均）而不是 nearest（点采样）：
      // 点采样会把某一个原始像素的颜色原样保留下来，等于没打散信息。
      const downscaled = await sharp(patch)
        .resize(smallW, smallH, { kernel: "cubic" })
        .toBuffer();

      processed = await sharp(downscaled)
        .resize(box.width, box.height, { kernel: "nearest" })
        .toBuffer();
    }

    working = await sharp(working)
      .composite([{ input: processed, left: box.left, top: box.top }])
      .toBuffer();
  }

  return working;
}

export interface RenderedVariant {
  buffer: Buffer;
  width: number;
  height: number;
}

export type RenderedVariants = Record<ImageVariant, RenderedVariant>;

/** 由已脱敏的图生成 thumb / grid / full 三档 WebP */
export async function renderVariants(sanitized: Buffer): Promise<RenderedVariants> {
  const result = {} as RenderedVariants;

  for (const [name, targetWidth] of Object.entries(IMAGE_VARIANTS) as [ImageVariant, number][]) {
    const { data, info } = await sharp(sanitized)
      .resize({ width: targetWidth, withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    result[name] = { buffer: data, width: info.width, height: info.height };
  }

  return result;
}

/**
 * 完整渲染流程：清洗元数据 → 应用模糊 → 生成各档变体。
 * 每次都需要从**原图**重新开始，避免反复编辑导致模糊叠加失真。
 */
export async function processImage(
  originalBuffer: Buffer,
  regions: BlurRegionInput[],
): Promise<{ variants: RenderedVariants; width: number; height: number }> {
  const sanitizedResult = await sanitizeImage(originalBuffer);
  const blurred = await applyBlurRegions(
    sanitizedResult.buffer,
    regions,
    sanitizedResult.width,
    sanitizedResult.height,
  );
  const variants = await renderVariants(blurred);
  return {
    variants,
    width: sanitizedResult.width,
    height: sanitizedResult.height,
  };
}
