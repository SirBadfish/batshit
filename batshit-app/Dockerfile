# glibc base (not alpine): onnxruntime-node — the built-in memory embedder runtime —
# ships glibc-only Linux binaries that musl cannot dlopen.
FROM node:24-slim AS deps

WORKDIR /opt/batshit/batshit-app

COPY batshit-app/package*.json ./
COPY batshit-app/patches ./patches
RUN npm ci

FROM deps AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY batshit-app ./
COPY docs/batshit_System_Prompts ../docs/batshit_System_Prompts
ENV BATSHIT_SVELTE_ADAPTER=node
RUN node scripts/build-anchored-project-reader.mjs \
    && test -x scripts/anchored-project-reader \
    && node -e 'const fs=require("node:fs"); const b=fs.readFileSync("scripts/anchored-project-reader"); const machine=b.readUInt16LE(18); if (b.subarray(0,4).toString("hex")!=="7f454c46" || machine!==(process.arch==="arm64"?183:62)) process.exit(1)'
RUN npm run generate:brand-icons && npm run build
# Server code only ever loads onnxruntime-node's linux/<arch> binaries; the browser/wasm
# build and foreign-platform binaries are ~310MB of dead weight. The trailing test fails
# the build loudly if an onnxruntime-node layout change ever invalidates this prune.
RUN npm prune --omit=dev \
    && rm -rf node_modules/onnxruntime-web \
        node_modules/onnxruntime-node/bin/napi-v6/win32 \
        node_modules/onnxruntime-node/bin/napi-v6/darwin \
    && find node_modules/onnxruntime-node/bin/napi-v6/linux -mindepth 1 -maxdepth 1 -type d \
        ! -name "$(node -p process.arch)" -exec rm -rf {} + \
    && test -e "node_modules/onnxruntime-node/bin/napi-v6/linux/$(node -p process.arch)/onnxruntime_binding.node"

FROM node:24-slim AS runtime

WORKDIR /opt/batshit/batshit-app

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash bubblewrap ca-certificates curl git openssh-client python3 python3-pip zsh \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && groupadd --system --gid 10001 batshit-cli \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/batshit-cli --shell /bin/sh batshit-cli \
    && mkdir -p /home/batshit-cli \
    && chown -R 10001:10001 /home/batshit-cli
RUN test -x /usr/bin/git && /usr/bin/git --version

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PATH=/opt/batshit/batshit-app/node_modules/.bin:$PATH

COPY --from=build /opt/batshit/batshit-app/build ./build
# The Hair and Clothing repositories read trusted built-in catalogs and every
# referenced asset from process.cwd()/static/goon-assets. build/client serves
# browser URLs but does not provide that server-readable filesystem path.
COPY --from=build /opt/batshit/batshit-app/static/goon-assets ./static/goon-assets
RUN test -f static/goon-assets/hair/v2/catalog.json \
    && test -f static/goon-assets/clothing/v1/catalog.json
COPY --from=build /opt/batshit/batshit-app/node_modules ./node_modules
COPY --from=build /opt/batshit/batshit-app/package.json ./package.json
COPY --from=build /opt/batshit/batshit-app/scripts ./scripts
RUN test -s scripts/command-group-guardian.mjs
RUN test -x scripts/anchored-project-reader \
    && test -s scripts/anchored-project-reader.c
COPY docs/batshit_System_Prompts ../docs/batshit_System_Prompts
COPY docs/user-docs/user-templates/batshit-official-n8n-workflow-templates ../docs/user-docs/user-templates/batshit-official-n8n-workflow-templates
COPY batshit-app/docker-entrypoint.sh /usr/local/bin/batshit-app-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/batshit-app-entrypoint \
    && chmod 0755 /usr/local/bin/batshit-app-entrypoint

EXPOSE 3000

ENTRYPOINT ["batshit-app-entrypoint"]
CMD ["node", "build"]
