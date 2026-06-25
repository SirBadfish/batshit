FROM node:24-bookworm-slim

ARG AGENT_BROWSER_VERSION=0.24.1

ENV NODE_ENV=production \
  BATSHIT_AGENT_BROWSER_HOST=0.0.0.0 \
  BATSHIT_AGENT_BROWSER_PORT=8091 \
  BATSHIT_AGENT_BROWSER_TMP_DIR=/runtime/agent-browser/tmp \
  AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
  AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage \
  AGENT_BROWSER_SCREENSHOT_DIR=/runtime/agent-browser/tmp \
  AGENT_BROWSER_DOWNLOAD_PATH=/runtime/agent-browser/tmp

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates chromium dumb-init \
  && npm install -g "agent-browser@${AGENT_BROWSER_VERSION}" \
  && mkdir -p /opt/batshit-agent-browser-sidecar /runtime/agent-browser/tmp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/batshit-agent-browser-sidecar
COPY tools/docker/agent-browser-sidecar/server.mjs ./server.mjs

EXPOSE 8091

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "/opt/batshit-agent-browser-sidecar/server.mjs"]
