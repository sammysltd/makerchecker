FROM node:22-alpine AS build
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

FROM node:22-alpine
WORKDIR /app
# Drop the bundled npm/npx CLI: the runtime runs node directly (pnpm/corepack are
# build-time only), so npm is unused weight whose vendored deps trip the image scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production
ENV DEMO_DATA_DIR=/app/examples/daily-cash-reconciliation
ENV MAKERCHECKER_WEB_DIST=/app/web-dist
COPY --from=build /app /app
COPY --from=build /repo/packages/web/dist /app/web-dist
COPY examples /app/examples
EXPOSE 3000
CMD ["node", "dist/index.js"]
