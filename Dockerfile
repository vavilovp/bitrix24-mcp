FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/vavilovp/bitrix24-mcp" \
      org.opencontainers.image.description="Bitrix24 MCP server, remote HTTPS mode with Bitrix24 OAuth" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server/http.js"]
