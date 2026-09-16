import path from "node:path";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

export interface DetectionBox {
  /** 归一化坐标（0–1），与 blur_regions 的存储格式一致 */
  x: number;
  y: number;
  w: number;
  h: number;
  label: "face" | "plate";
  confidence: number;
}

export interface DetectionOutcome {
  available: boolean;
  reason?: string;
  boxes: DetectionBox[];
}

function tryRequire(moduleName: string): Record<string, unknown> | undefined {
  try {
    // 可选依赖，缺失时走人工兜底而不是让服务崩溃
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(moduleName) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** 人脸检测：需要 @vladmandic/face-api + @tensorflow/tfjs-node 与本地模型文件 */
async function detectFaces(buffer: Buffer): Promise<DetectionOutcome> {
  const faceapi = tryRequire("@vladmandic/face-api");
  const tf = tryRequire("@tensorflow/tfjs-node");

  if (!faceapi || !tf) {
    return {
      available: false,
      reason: "未安装 @vladmandic/face-api 或 @tensorflow/tfjs-node，已转为人工确认",
      boxes: [],
    };
  }

  try {
    const api = faceapi as unknown as {
      nets: Record<string, { loadFromDisk: (dir: string) => Promise<void> }>;
      tf: { tensor3d: (data: Uint8Array, shape: [number, number, number]) => unknown };
      detectAllFaces: (
        input: unknown,
        options: unknown,
      ) => Promise<Array<{ box: { x: number; y: number; width: number; height: number }; score: number }>>;
      TinyFaceDetectorOptions: new (options: Record<string, unknown>) => unknown;
    };

    await api.nets.tinyFaceDetector.loadFromDisk(env.FACE_MODEL_DIR);

    const sharp = tryRequire("sharp") as unknown as {
      default: (input: Buffer) => {
        ensureAlpha: () => { raw: () => { toBuffer: (options: { resolveWithObject: true }) => Promise<{ data: Buffer; info: { width: number; height: number } }> } };
      };
    };
    const decoder = (sharp.default ?? (sharp as unknown as (input: Buffer) => unknown)) as (
      input: Buffer,
    ) => {
      ensureAlpha: () => {
        raw: () => {
          toBuffer: (options: { resolveWithObject: true }) => Promise<{
            data: Buffer;
            info: { width: number; height: number };
          }>;
        };
      };
    };

    const { data, info } = await decoder(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const tensor = api.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 4]);
    const detections = await api.detectAllFaces(
      tensor,
      new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: env.FACE_CONFIDENCE_THRESHOLD }),
    );

    const boxes = detections.map((detection) => ({
      x: round(detection.box.x / info.width),
      y: round(detection.box.y / info.height),
      w: round(detection.box.width / info.width),
      h: round(detection.box.height / info.height),
      label: "face" as const,
      confidence: round(detection.score),
    }));

    return { available: true, boxes };
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "人脸检测执行失败，转为人工确认");
    return { available: false, reason: `人脸检测失败：${(error as Error).message}`, boxes: [] };
  }
}

const CN_PLATE = /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-HJ-NP-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]/;

/** 车牌检测：基于 tesseract.js 的 OCR 识别，再按号牌规则过滤 */
async function detectPlates(buffer: Buffer): Promise<DetectionOutcome> {
  const tesseract = tryRequire("tesseract.js");
  if (!tesseract) {
    return {
      available: false,
      reason: "未安装 tesseract.js，已转为人工确认",
      boxes: [],
    };
  }

  try {
    const recognize = tesseract.recognize as (
      image: Buffer,
      lang: string,
    ) => Promise<{ data: { words?: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> } }>;

    const { data } = await recognize(buffer, "chi_sim+eng");
    const sharpMeta = await (tryRequire("sharp") as unknown as {
      default: (input: Buffer) => { metadata: () => Promise<{ width?: number; height?: number }> };
    }).default(buffer).metadata();

    const width = sharpMeta.width ?? 1;
    const height = sharpMeta.height ?? 1;

    const boxes: DetectionBox[] = [];
    for (const word of data.words ?? []) {
      const text = word.text.replace(/\s+/g, "");
      if (!CN_PLATE.test(text)) continue;

      boxes.push({
        x: round(word.bbox.x0 / width),
        y: round(word.bbox.y0 / height),
        w: round((word.bbox.x1 - word.bbox.x0) / width),
        h: round((word.bbox.y1 - word.bbox.y0) / height),
        label: "plate",
        confidence: round(word.confidence / 100),
      });
    }

    return { available: true, boxes };
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "车牌检测执行失败，转为人工确认");
    return { available: false, reason: `车牌检测失败：${(error as Error).message}`, boxes: [] };
  }
}

export interface DetectionResult {
  /** 至少有一个检测器可用 */
  anyAvailable: boolean;
  boxes: DetectionBox[];
  notes: string[];
}

/**
 * 隐私检测总入口。
 *
 * 设计原则：检测是**增强**而非前提。检测器缺失或失败时返回 anyAvailable=false，
 * 图片会被置为 needs_manual，必须由审核员框选并确认后才能发布——闭环不打折。
 */
export async function detectSensitiveRegions(buffer: Buffer): Promise<DetectionResult> {
  const notes: string[] = [];
  const boxes: DetectionBox[] = [];
  let anyAvailable = false;

  if (env.ENABLE_FACE_DETECTION) {
    const face = await detectFaces(buffer);
    anyAvailable ||= face.available;
    boxes.push(...face.boxes);
    if (face.reason) notes.push(face.reason);
  } else {
    notes.push("人脸检测未启用（ENABLE_FACE_DETECTION=false）");
  }

  if (env.ENABLE_PLATE_DETECTION) {
    const plate = await detectPlates(buffer);
    anyAvailable ||= plate.available;
    boxes.push(...plate.boxes);
    if (plate.reason) notes.push(plate.reason);
  } else {
    notes.push("车牌检测未启用（ENABLE_PLATE_DETECTION=false）");
  }

  return { anyAvailable, boxes, notes };
}

export function faceModelDir(): string {
  return path.resolve(process.cwd(), env.FACE_MODEL_DIR);
}
