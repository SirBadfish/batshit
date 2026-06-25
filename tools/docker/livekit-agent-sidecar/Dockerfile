FROM node:24-bookworm-slim

ENV NODE_OPTIONS=--no-warnings \
  NODE_NO_WARNINGS=1 \
  LIVEKIT_AGENT_HEALTH_PORT=7899 \
  LIVEKIT_AGENT_MODE=batshit-bridge

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && mkdir -p /opt/batshit-livekit-agent-sidecar \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/batshit-livekit-agent-sidecar

COPY tools/livekit-agent-sidecar/package*.json ./
RUN npm ci

COPY tools/livekit-agent-sidecar/tsconfig.json ./tsconfig.json
COPY tools/livekit-agent-sidecar/src ./src

EXPOSE 7899

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "start"]
