FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies (workspace-aware)
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspace @nookeb/api --workspace @nookeb/shared --include-workspace-root

# Build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build --workspace @nookeb/shared && npm run build --workspace @nookeb/api

ENV NODE_ENV=production
EXPOSE 3001

# API server; override CMD with `npm run start:worker --workspace @nookeb/api` for the worker process
CMD ["npm", "run", "start", "--workspace", "@nookeb/api"]
