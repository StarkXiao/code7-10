# ---------- 构建阶段 ----------
FROM node:20-alpine AS build

WORKDIR /app

# Prisma 引擎在 alpine 上依赖 openssl
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci --no-audit --no-fund

# 先生成 Prisma Client，再编译业务代码，避免类型缺失
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache openssl \
  && addgroup -S app \
  && adduser -S app -G app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# prisma 已放在 dependencies 里，运行阶段才能执行 migrate deploy
COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist

RUN mkdir -p /app/storage/public /app/storage/private \
  && chown -R app:app /app

USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
