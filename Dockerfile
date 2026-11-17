# PulseDNS 控制面板镜像：在本机按固定 commit 的源码构建，数据保存在外置 MySQL / MariaDB。
# 基础镜像按摘要固定，构建结果不受上游标签变动影响。
FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# 32 位随机入口路径在构建时写入页面资源，必须与运行时的 PULSEDNS_BASE_PATH 一致。
ARG PULSEDNS_BASE_PATH
RUN test -n "$PULSEDNS_BASE_PATH" && echo "$PULSEDNS_BASE_PATH" | grep -Eq '^/[a-f0-9]{32}$' \
    || { echo 'PULSEDNS_BASE_PATH 必须是 / 加 32 位小写十六进制，例如 /0123456789abcdef0123456789abcdef' >&2; exit 1; }
ENV PULSEDNS_BASE_PATH=$PULSEDNS_BASE_PATH
RUN pnpm build

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/public ./public
ARG PULSEDNS_BASE_PATH
ENV PULSEDNS_BASE_PATH=$PULSEDNS_BASE_PATH
USER node
EXPOSE 3100
CMD ["node", "node_modules/vinext/dist/cli.js", "start", "--hostname", "0.0.0.0", "--port", "3100"]
