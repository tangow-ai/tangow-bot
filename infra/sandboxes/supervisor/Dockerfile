FROM node:22-bookworm-slim
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY patches patches
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/logging packages/logging
COPY infra/sandboxes/supervisor infra/sandboxes/supervisor
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@tangow/sandbox-supervisor..."
# After the install layer so a skill edit does not reinstall; --chmod survives a restrictive host umask.
COPY --chmod=755 skills skills
WORKDIR /app/infra/sandboxes/supervisor
# Not through pnpm: corepack would download it at startup for a user other than root.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
