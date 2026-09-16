import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

let transporter: Transporter | undefined;

function getTransporter(): Transporter | undefined {
  if (env.MAIL_DRIVER !== "smtp") return undefined;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

/**
 * 邮件是"尽力而为"的通道：站内信才是必达。
 * 邮件发送失败只记日志，绝不能让业务流程因此失败。
 */
export async function sendMail(message: MailMessage): Promise<boolean> {
  const transport = getTransporter();

  if (!transport) {
    logger.info({ to: message.to, subject: message.subject }, "[mail:console] 邮件内容已输出");
    return true;
  }

  try {
    await transport.sendMail({ from: env.MAIL_FROM, ...message });
    return true;
  } catch (error) {
    logger.warn({ err: (error as Error).message, to: message.to }, "邮件发送失败");
    return false;
  }
}

export async function verifyMailer(): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) return true;
  try {
    await transport.verify();
    return true;
  } catch {
    return false;
  }
}
