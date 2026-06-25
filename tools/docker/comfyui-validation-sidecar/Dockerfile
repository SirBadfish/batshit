FROM node:22-alpine

WORKDIR /app

COPY tools/docker/comfyui-validation-sidecar/server.mjs ./server.mjs

ENV BATSHIT_COMFYUI_VALIDATION_HOST=0.0.0.0
ENV BATSHIT_COMFYUI_VALIDATION_PORT=8188
ENV BATSHIT_COMFYUI_VALIDATION_DATA_DIR=/data

EXPOSE 8188

CMD ["node", "server.mjs"]
