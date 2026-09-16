import { env } from "./env";

// CORS 白名单。
// 允许配置的前端源；开发环境额外放行本机常见端口，
// 这样团队里谁起 dev server 都不会被拦。
export function buildAllowedOrigins(): string[] {
  const origins = new Set<string>([env.FRONTEND_BASE_URL, env.APP_BASE_URL]);

  if (env.NODE_ENV !== "production") {
    for (const port of [5173, 5174, 4173, 8080, 3000]) {
      origins.add(`http://localhost:${port}`);
      origins.add(`http://127.0.0.1:${port}`);
    }
  }

  return [...origins].filter(Boolean);
}
