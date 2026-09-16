import { z } from "zod";

const passwordRule = z
  .string()
  .min(8, "密码至少 8 位")
  .max(72, "密码过长")
  .regex(/[A-Za-z]/, "密码需包含字母")
  .regex(/\d/, "密码需包含数字");

export const registerSchema = z
  .object({
    email: z.string().email("邮箱格式不正确").optional(),
    phone: z
      .string()
      .regex(/^1[3-9]\d{9}$/, "手机号格式不正确")
      .optional(),
    password: passwordRule,
    nickname: z.string().trim().min(1, "请填写昵称").max(20, "昵称不超过 20 个字"),
  })
  .refine((data) => Boolean(data.email || data.phone), {
    message: "请填写邮箱或手机号",
    path: ["email"],
  });

export const loginSchema = z.object({
  account: z.string().trim().min(1, "请填写账号"),
  password: z.string().min(1, "请填写密码"),
  captchaId: z.string().optional(),
  captchaCode: z.string().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "请填写当前密码"),
  newPassword: passwordRule,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
