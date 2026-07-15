FROM node:24-alpine AS deps

WORKDIR /opt/batshit/batshit-server/server

COPY batshit-server/server/package*.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime

WORKDIR /opt/batshit/batshit-server/server

ENV NODE_ENV=production \
    BATSHIT_SERVER_HOST=0.0.0.0 \
    PORT=5600 \
    ENABLE_HTTPS=false \
    HTTPS_ONLY=false \
    BATSHIT_REDIS_REQUIRED=true \
    UPLOADS_DIR=/data/uploads

RUN apk add --no-cache ffmpeg

COPY --from=deps /opt/batshit/batshit-server/server/node_modules ./node_modules
COPY batshit-server/server/package*.json ./
COPY batshit-server/server/markdownlint_fix_helper.js ./markdownlint_fix_helper.js
COPY batshit-server/server/src ./src
COPY batshit-app/static/goons/facial-artwork/v3 /opt/batshit/batshit-app/static/goons/facial-artwork/v3

RUN mkdir -p /data/uploads

EXPOSE 5600

CMD ["node", "src/index.js"]
