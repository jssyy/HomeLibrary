# 家庭图书馆 —— 容器镜像，Render / Railway / Zeabur / 自己的服务器都能用
# node:sqlite 需要 Node 22.5+
FROM node:22-slim

ENV NODE_ENV=production \
    HL_HTTPS=false \
    HL_DATA_DIR=/data

WORKDIR /app

# 先装依赖，利用镜像层缓存；postinstall 会把前端依赖复制到 public/vendor
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# 数据库、封面、电子书都在 /data，部署时挂持久化磁盘到这里
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "server.js"]
