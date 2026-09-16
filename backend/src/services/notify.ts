import { prisma, toJsonValue } from "../db/prisma";
import { NOTIFICATION_TYPES, type NotificationType } from "../config/constants";
import { logger } from "../utils/logger";
import { sendMail } from "./mailer";

export interface NotifyInput {
  userId: bigint;
  type: NotificationType;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
}

/**
 * 站内信必达 + 邮件尽力而为。
 * 通知失败不影响主流程，但要留下日志，避免"用户没收到也不知道为什么"。
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title.slice(0, 80),
        body: input.body?.slice(0, 300) ?? null,
        payload: toJsonValue(input.payload ?? {}),
      },
    });

    await maybeSendEmail(input);
  } catch (error) {
    logger.error(
      { err: (error as Error).message, userId: input.userId.toString(), type: input.type },
      "通知创建失败",
    );
  }
}

async function maybeSendEmail(input: NotifyInput): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      email: true,
      emailNotify: true,
      settings: { select: { notifyEmail: true } },
    },
  });

  if (!user?.email) return;
  if (!user.emailNotify) return;
  if (user.settings && !user.settings.notifyEmail) return;

  const sent = await sendMail({
    to: user.email,
    subject: `[公共空间细节地图] ${input.title}`,
    text: `${input.body ?? NOTIFICATION_TYPES[input.type]}\n\n如需查看详情，请登录站点。`,
  });

  if (sent) {
    await prisma.notification.updateMany({
      where: { userId: input.userId, type: input.type, emailSent: false },
      data: { emailSent: true },
    });
  }
}
