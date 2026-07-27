# Studio OS — single-container deployment.
# better-sqlite3 ships prebuilt binaries for glibc (node:*-slim), so no
# build toolchain is needed.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts

# SQLite database + email outbox live here — mount a volume to persist.
ENV DB_PATH=/app/data/studio.db
VOLUME /app/data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
