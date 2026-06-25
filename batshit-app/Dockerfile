FROM node:24-alpine AS deps

WORKDIR /opt/batshit/batshit-app

COPY batshit-app/package*.json ./
COPY batshit-app/patches ./patches
RUN npm ci

FROM deps AS build

COPY batshit-app ./
COPY docs/batshit_System_Prompts ../docs/batshit_System_Prompts
ENV BATSHIT_SVELTE_ADAPTER=node
RUN npm run generate:brand-icons && npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime

WORKDIR /opt/batshit/batshit-app

RUN apk add --no-cache bash bubblewrap curl git openssh-client py3-pip python3 zsh \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && addgroup -S -g 10001 batshit-cli \
    && adduser -S -D -u 10001 -G batshit-cli -h /home/batshit-cli -s /bin/sh batshit-cli \
    && mkdir -p /home/batshit-cli \
    && chown -R 10001:10001 /home/batshit-cli

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PATH=/opt/batshit/batshit-app/node_modules/.bin:$PATH

COPY --from=build /opt/batshit/batshit-app/build ./build
COPY --from=build /opt/batshit/batshit-app/node_modules ./node_modules
COPY --from=build /opt/batshit/batshit-app/package.json ./package.json
COPY --from=build /opt/batshit/batshit-app/scripts ./scripts
COPY docs/batshit_System_Prompts ../docs/batshit_System_Prompts
COPY docs/user-docs/user-templates/batshit-official-n8n-workflow-templates ../docs/user-docs/user-templates/batshit-official-n8n-workflow-templates
COPY batshit-app/docker-entrypoint.sh /usr/local/bin/batshit-app-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/batshit-app-entrypoint \
    && chmod 0755 /usr/local/bin/batshit-app-entrypoint

EXPOSE 3000

ENTRYPOINT ["batshit-app-entrypoint"]
CMD ["node", "build"]
