import { AppError } from "../../utils/errors";
import { ERROR_CODES } from "../../config/constants";

/**
 * 硬性拦截词库。
 * 这里只放"任何场景下都不应出现在公共空间地图里"的类别；
 * 灰色地带交给人工审核，避免误伤正常描述。
 */
const BLOCKED_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "赌博诱导", pattern: /(网络赌场|博彩平台|下注网址|时时彩|六合彩特码)/i },
  { label: "色情内容", pattern: /(约炮|招嫖|色情服务|成人影片资源)/i },
  { label: "违法交易", pattern: /(代开发票|办证刻章|枪支弹药|管制刀具出售|买卖账号)/i },
  { label: "诈骗引流", pattern: /(刷单兼职|日结高薪|稳赚不赔|内部渠道加我)/i },
];

/** 个人信息识别，命中即阻止提交 */
const PII_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "手机号", pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { label: "身份证号", pattern: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { label: "银行卡号", pattern: /(?<!\d)\d{16,19}(?!\d)/ },
  { label: "微信号", pattern: /(微信|weixin|wechat|vx|v信|威信)\s*[:：]?\s*[A-Za-z0-9_-]{5,}/i },
  { label: "QQ 号", pattern: /(qq|扣扣)\s*[:：]?\s*[1-9]\d{4,}/i },
  { label: "外部链接", pattern: /(https?:\/\/|www\.[a-z0-9-]+\.|t\.cn\/|\.com\/)/i },
  { label: "精确门牌号", pattern: /\d{1,4}\s*号\s*\d{1,3}\s*(室|楼|单元)/ },
];

export interface ContentFlag {
  type: "blocked" | "pii";
  label: string;
}

export interface ContentCheckResult {
  ok: boolean;
  flags: ContentFlag[];
}

export function checkText(text: string | null | undefined): ContentCheckResult {
  const content = (text ?? "").trim();
  if (!content) return { ok: true, flags: [] };

  const flags: ContentFlag[] = [];
  for (const { label, pattern } of BLOCKED_PATTERNS) {
    if (pattern.test(content)) flags.push({ type: "blocked", label });
  }
  for (const { label, pattern } of PII_PATTERNS) {
    if (pattern.test(content)) flags.push({ type: "pii", label });
  }

  return { ok: flags.length === 0, flags };
}

/** 阻断型违规：直接拒绝，并告诉用户具体原因 */
export function assertNoBlockedContent(...texts: Array<string | null | undefined>): void {
  const labels = new Set<string>();
  for (const text of texts) {
    for (const flag of checkText(text).flags) {
      if (flag.type === "blocked") labels.add(flag.label);
    }
  }
  if (labels.size > 0) {
    throw AppError.badRequest(`内容包含不允许的信息：${[...labels].join("、")}`);
  }
}

/**
 * 个人信息检查：不阻断编辑（用户可能在草稿阶段还没整理好），
 * 但在提交审核时阻断，并给出友好的可操作提示。
 */
export function assertNoPii(...texts: Array<string | null | undefined>): void {
  const labels = new Set<string>();
  for (const text of texts) {
    for (const flag of checkText(text).flags) {
      if (flag.type === "pii") labels.add(flag.label);
    }
  }
  if (labels.size > 0) {
    throw new AppError(
      422,
      ERROR_CODES.COMMENT_PII_BLOCKED,
      `内容疑似包含个人信息（${[...labels].join("、")}），请删除后再提交。这样既保护你自己，也保护他人。`,
      { labels: [...labels] },
    );
  }
}

/** 供管理端查看当前生效的词库规模 */
export const filterStats = {
  blockedPatterns: BLOCKED_PATTERNS.length,
  piiPatterns: PII_PATTERNS.length,
  blockedLabels: BLOCKED_PATTERNS.map((item) => item.label),
  piiLabels: PII_PATTERNS.map((item) => item.label),
};
