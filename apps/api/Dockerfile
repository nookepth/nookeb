FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies (workspace-aware)
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN npm ci --include=dev --workspace @nookeb/api --workspace @nookeb/shared --include-workspace-root

# Build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

# FIX 16 — pre-seed the OCR assets, and FAIL THE BUILD if the Thai font can't
# be fetched and verified. scan-enhance.service.ts no longer downloads it at
# runtime, so an image without it ships a broken searchable-PDF text layer.
#
# This step is not redundant with apps/api's `postinstall`. `npm ci` above runs
# with only the package.json files copied — apps/api/scripts/ does not exist
# yet at that point, so the postinstall hook fails to find the script and its
# `|| exit 0` swallows the error. The font was therefore NEVER pre-seeded in
# this image; the runtime CDN fetch that FIX 16 removed was silently the only
# thing providing it. Run it here, after the source is in place, and without
# swallowing the exit code.
RUN node apps/api/scripts/download-tessdata.js

RUN npm run build --workspace @nookeb/shared && npm run build --workspace @nookeb/api

ENV NODE_ENV=production
EXPOSE 3001

# API server; override CMD with `npm run start:worker --workspace @nookeb/api` for the worker process
CMD ["npm", "run", "start", "--workspace", "@nookeb/api"]
