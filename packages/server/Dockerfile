# Knot 记忆服务（远程模式部署镜像）
# 构建方式（在仓库根目录执行）：
#   pnpm build:server                # 先产出 dist-server/index.js（bundle）
#   docker build -t knot-server -f server/Dockerfile .
# 运行：
#   docker run -d -p 27184:27184 \
#     -e KNOT_TOKEN=<访问令牌> \
#     -e KNOT_LLM_API_KEY=<key> \
#     -v knot-data:/data \
#     knot-server
# 说明：用 glibc 基础镜像（bookworm-slim），better-sqlite3 可直接命中预编译产物，
# 无需在容器里跑 node-gyp。

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# 依赖层单独缓存：只装运行时依赖（fastify / mem0ai / better-sqlite3）
COPY server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# 打包产物：仓库根目录先跑 pnpm build:server，再以仓库根为构建上下文
COPY dist-server/index.js ./dist/index.js

# mem0ai 的向量库（better-sqlite3）是 external，运行时从 node_modules 解析
ENV KNOT_HOST=0.0.0.0 \
    KNOT_PORT=27184 \
    KNOT_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 27184

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KNOT_PORT||27184)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
