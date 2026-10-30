FROM node:22-alpine

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy application source, SQL migrations, templates, and User Guide PDFs
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY templates ./templates
COPY GST_Control_ERP_Step_by_Step_Guide_With_Screenshots.pdf ./
COPY GST_Control_ERP_User_Manual_English.pdf ./

# Create persistent output & uploads directories
RUN mkdir -p /app/output/uploads /app/output/returns

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4310
ENV GST_OUTPUT_DIR=/app/output
ENV GST_INPUT_DIR=/app/output/uploads

EXPOSE 4310

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4310/api/health || exit 1

CMD ["sh", "-c", "npx tsx scripts/docker-init.ts && npx tsx src/server/server.ts"]
