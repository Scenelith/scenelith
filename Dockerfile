FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

FROM base AS builder
ENV FRAMEFLOW_BUILD=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS production
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf \
    /var/lib/apt/lists/* \
    /usr/local/bin/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/lib/node_modules/corepack \
    /usr/local/lib/node_modules/npm
RUN groupadd --system --gid 1001 scenelith && useradd --system --uid 1001 --gid scenelith scenelith
COPY --from=builder --chown=scenelith:scenelith /app/.next/standalone ./
COPY --from=production-dependencies --chown=scenelith:scenelith /app/node_modules ./node_modules
COPY --from=dependencies --chown=scenelith:scenelith /app/node_modules/@img ./node_modules/@img
COPY --from=builder --chown=scenelith:scenelith /app/.next/static ./.next/static
COPY --from=builder --chown=scenelith:scenelith /app/public ./public
COPY --chown=scenelith:scenelith package.json package-lock.json tsconfig.json ./
COPY --chown=scenelith:scenelith src ./src
COPY --chown=scenelith:scenelith database ./database
COPY --chown=scenelith:scenelith collaboration ./collaboration
RUN mkdir -p /app/data/storage && chown -R scenelith:scenelith /app/data
USER scenelith
EXPOSE 3000
EXPOSE 3001
EXPOSE 1234
VOLUME ["/app/data"]
CMD ["node", "server.js"]
