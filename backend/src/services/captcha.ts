import crypto from "node:crypto";
import { redis } from "../db/redis";
import { logger } from "../utils/logger";

// 去掉容易混淆的 0/O/1/I
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TTL_SECONDS = 300;

function randomChar(): string {
  return ALPHABET[crypto.randomInt(0, ALPHABET.length)] as string;
}

function buildSvg(code: string): string {
  const width = 120;
  const height = 40;
  const chars = [...code];

  const glyphs = chars
    .map((char, index) => {
      const x = 16 + index * 24 + crypto.randomInt(-2, 3);
      const y = 28 + crypto.randomInt(-3, 4);
      const rotate = crypto.randomInt(-18, 19);
      const fontSize = 22 + crypto.randomInt(-2, 3);
      return `<text x="${x}" y="${y}" font-size="${fontSize}" font-family="monospace" font-weight="bold" fill="#2f3542" transform="rotate(${rotate} ${x} ${y})">${char}</text>`;
    })
    .join("");

  const noiseLines = Array.from({ length: 4 })
    .map(() => {
      const x1 = crypto.randomInt(0, width);
      const y1 = crypto.randomInt(0, height);
      const x2 = crypto.randomInt(0, width);
      const y2 = crypto.randomInt(0, height);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#a4b0be" stroke-width="1" />`;
    })
    .join("");

  const dots = Array.from({ length: 28 })
    .map(() => {
      const cx = crypto.randomInt(0, width);
      const cy = crypto.randomInt(0, height);
      return `<circle cx="${cx}" cy="${cy}" r="1" fill="#ced6e0" />`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="图形验证码"><rect width="${width}" height="${height}" fill="#f1f2f6" />${noiseLines}${dots}${glyphs}</svg>`;
}

export interface CaptchaChallenge {
  captchaId: string;
  svg: string;
}

/**
 * 生成图形验证码。
 * Redis 不可用时返回 null，调用方据此跳过验证码步骤
 * （否则会把所有用户挡在门外，验证码反而成了单点故障）。
 */
export async function createCaptcha(): Promise<CaptchaChallenge | null> {
  const code = [0, 1, 2, 3].map(randomChar).join("");
  const captchaId = crypto.randomUUID().replace(/-/g, "");

  try {
    await redis.set(`captcha:${captchaId}`, code.toLowerCase(), "EX", TTL_SECONDS);
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "验证码存储失败");
    return null;
  }

  return { captchaId, svg: buildSvg(code) };
}

/** 校验并立即销毁，防止重放 */
export async function verifyCaptcha(captchaId: string, input: string): Promise<boolean> {
  if (!captchaId || !input) return false;

  const key = `captcha:${captchaId}`;
  try {
    const expected = await redis.get(key);
    await redis.del(key);
    if (!expected) return false;
    return expected.toLowerCase() === input.trim().toLowerCase();
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "验证码校验失败");
    // Redis 异常时放行，避免验证码成为单点故障
    return true;
  }
}
