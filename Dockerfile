FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node studio ./studio
COPY --chown=node:node flow-model-capabilities.json ./flow-model-capabilities.json
COPY --chown=node:node flow-selectors.json ./flow-selectors.json
RUN mkdir -p /data/.flow-mcp /data/output && chown -R node:node /data
ENV FLOW_MCP_HOST=0.0.0.0 \
    FLOW_MCP_HOME=/data/.flow-mcp \
    FLOW_MCP_OUTPUT=/data/output
USER node
EXPOSE 18899
VOLUME ["/data"]
CMD ["node", "dist/serve.js"]
