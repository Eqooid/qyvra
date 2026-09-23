FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates qpdf && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
# Independent npm lockfiles and file: links are the established package layout.
COPY packages/storage/package*.json packages/storage/
RUN npm --prefix packages/storage ci
COPY packages/database/package*.json packages/database/
RUN npm --prefix packages/database ci
COPY apps/api/package*.json apps/api/
RUN npm --prefix apps/api ci
COPY packages/storage/ packages/storage/
COPY packages/database/ packages/database/
COPY apps/api/ apps/api/
RUN npm --prefix apps/api run build

FROM base AS migration
COPY --from=build /app/packages/database/node_modules /app/packages/database/node_modules
COPY --from=build /app/packages/database/prisma /app/packages/database/prisma
COPY --from=build /app/packages/database/prisma.config.ts /app/packages/database/prisma.config.ts
COPY --from=build /app/packages/database/package.json /app/packages/database/package.json
COPY infrastructure/docker/database-command.cjs /app/infrastructure/docker/database-command.cjs
USER node
WORKDIR /app/packages/database
CMD ["node", "/app/infrastructure/docker/database-command.cjs", "node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM build AS production-dependencies
RUN npm --prefix apps/api prune --omit=dev && npm --prefix packages/database prune --omit=dev && npm --prefix packages/storage prune --omit=dev

FROM base AS runtime
COPY --from=production-dependencies /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/api/package.json /app/apps/api/package.json
COPY --from=production-dependencies /app/packages/database/node_modules /app/packages/database/node_modules
COPY --from=build /app/packages/database/dist /app/packages/database/dist
COPY --from=build /app/packages/database/package.json /app/packages/database/package.json
COPY --from=build /app/packages/storage/dist /app/packages/storage/dist
COPY --from=build /app/packages/storage/package.json /app/packages/storage/package.json
COPY infrastructure/docker/database-command.cjs /app/infrastructure/docker/database-command.cjs
RUN mkdir -p /data/brainless && chown node:node /data/brainless && chmod 700 /data/brainless
USER node
WORKDIR /app/apps/api
CMD ["node", "/app/infrastructure/docker/database-command.cjs", "node", "dist/main.js"]
