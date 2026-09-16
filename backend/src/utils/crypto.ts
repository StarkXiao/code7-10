import crypto from "node:crypto";

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** 生成可读但强度足够的随机密码，用于种子账号 */
export function randomPassword(length = 16): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*";
  const all = upper + lower + digits + symbols;

  const pick = (pool: string) => pool[crypto.randomInt(0, pool.length)] as string;
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));

  // Fisher-Yates 洗牌，避免固定前缀暴露构成
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join("");
}

/** 确定性伪随机：同一 seed + label 永远得到同一结果 */
export function deterministicRandom(seed: string, label: string): number {
  const digest = crypto.createHash("sha256").update(`${seed}:${label}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}
