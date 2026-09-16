# ---------- 构建阶段 ----------
FROM node:20-alpine AS build

WORKDIR /app

# Vite 在构建期就把变量打进产物，所以必须用构建参数传进来
ARG VITE_API_BASE_URL=http://localhost:3000/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:only

# ---------- 运行阶段 ----------
FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
