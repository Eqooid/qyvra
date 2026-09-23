FROM node:24-bookworm-slim AS build
WORKDIR /app/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/web/package*.json ./
RUN npm ci
COPY apps/web/ ./
ARG NEXT_PUBLIC_UPLOAD_MAX_BYTES=52428800
ENV NEXT_PUBLIC_API_BASE_URL=/api/v1
ENV NEXT_PUBLIC_UPLOAD_MAX_BYTES=$NEXT_PUBLIC_UPLOAD_MAX_BYTES
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./public
USER node
CMD ["node", "server.js"]
