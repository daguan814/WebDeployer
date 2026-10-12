# 用 Node 24（项目用了内置的 node:sqlite，需要 Node ≥ 22.5）
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=9090 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

WORKDIR /app

# 零依赖项目：没有 npm install 这一步，只把源码拷进来
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY tools ./tools

# 站点数据目录，实际运行时会被挂载出来持久化
RUN mkdir -p /data

EXPOSE 9090

# 开了 HTTPS 就试 https，没开就退回 http
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- --no-check-certificate https://127.0.0.1:9090/healthz \
   || wget -qO- http://127.0.0.1:9090/healthz || exit 1

# 故意用 root 跑：NAS 上的共享目录通常归 root 所有，
# 换成非 root 用户会因为写不进 data 目录而启动失败。
# 如果你的数据目录归 uid 1000，可以取消下面这行的注释改用 node 用户。
# USER node

CMD ["node", "server.js"]
