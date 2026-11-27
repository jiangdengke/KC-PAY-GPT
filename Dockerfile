# ============================================================
# KC GPT Pay — 轻量运行镜像（Node.js 20）
# 第三方代充（Desolate Open）+ Orbitcard 卡台 + 订阅管理
# ============================================================
FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

COPY server.js mysql-schema.sql ./
COPY src ./src
COPY public ./public

RUN mkdir -p data

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/api/public/runtime || exit 1

CMD ["node", "server.js"]
