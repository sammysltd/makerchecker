# Digest-pinned so a moved tag cannot swap the base out from under a build;
# Dependabot/Renovate bumps the digest as upstream re-publishes.
FROM node:22-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile --filter @makerchecker/server... --filter @makerchecker/web...
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/web packages/web
RUN pnpm --filter @makerchecker/server... run build && \
    pnpm --filter @makerchecker/web run build && \
    pnpm --filter @makerchecker/server deploy --prod /app

FROM node:22-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd
WORKDIR /app
# Drop the bundled npm/npx CLI: the runtime runs node directly (pnpm/corepack are
# build-time only), so npm is unused weight whose vendored deps trip the image scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production
ENV DEMO_DATA_DIR=/app/examples/daily-cash-reconciliation
ENV MAKERCHECKER_WEB_DIST=/app/web-dist
COPY --from=build --chown=node:node /app /app
COPY --from=build --chown=node:node /repo/packages/web/dist /app/web-dist
COPY --chown=node:node examples /app/examples
# Run as the unprivileged built-in `node` user (uid 1000) so the runtime cannot
# write outside its data dir and passes non-root PodSecurity. The signing key is
# written under MAKERCHECKER_DATA_DIR; pre-own both the /data mount target and
# the default ./data (=/app/data) so a fresh named volume inherits node on first
# mount and the key write does not hit EACCES.
RUN mkdir -p /data /app/data && chown -R node:node /data /app
# Probe the real app route, not a static asset; busybox wget is the only HTTP
# client in the base image (no curl). /healthz is auth- and rate-limit-exempt.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
