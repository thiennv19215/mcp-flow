FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node studio ./studio
RUN mkdir -p /data/.flow-mcp && chown -R node:node /data
ENV FLOW_AUTH_HOST=0.0.0.0 \
    FLOW_AUTH_PORT=18900 \
    FLOW_MCP_HOME=/data/.flow-mcp
USER node
EXPOSE 18900
VOLUME ["/data"]
CMD ["node", "dist/auth-server.js"]
