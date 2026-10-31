# syntax=docker/dockerfile:1
# Queuezen production image.
#   docker build -t queuezen .
#   docker run -p 3000:3000 -v queuezen-storage:/app/storage queuezen

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN addgroup -S queuezen && adduser -S queuezen -G queuezen
COPY --from=build --chown=queuezen:queuezen /app/.next ./.next
COPY --from=build --chown=queuezen:queuezen /app/node_modules ./node_modules
COPY --from=build --chown=queuezen:queuezen /app/public ./public
COPY --from=build --chown=queuezen:queuezen /app/scripts ./scripts
COPY --from=build --chown=queuezen:queuezen /app/package.json /app/server.js /app/next.config.ts ./
RUN mkdir -p storage && chown queuezen:queuezen storage
USER queuezen
VOLUME ["/app/storage"]
EXPOSE 3000
CMD ["node", "server.js"]
