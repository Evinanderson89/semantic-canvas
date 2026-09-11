FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production SC_SERVE_UI=true SC_HOST=0.0.0.0 PORT=5174 SC_DATA_DIR=/data SOURCES_PATH=/data/config/sources.yaml SC_ENV_PATH=/data/config/.env RLS_PATH=/data/config/policies.yaml
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
COPY sample-data ./sample-data
COPY sources.yaml ./sources.yaml
COPY security/policies.yaml ./security/policies.yaml
COPY deploy/entrypoint.sh deploy/empty-sources.yaml deploy/gateway-sources.yaml ./deploy/
RUN mkdir -p /data/config /lake && chown -R node:node /data /lake && chmod +x /app/deploy/entrypoint.sh
USER node
VOLUME ["/data"]
EXPOSE 5174
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:5174/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/server.ts"]
