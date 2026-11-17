# syntax=docker/dockerfile:1

# ---- build: install everything, generate the Prisma client, compile api + worker ----
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# prisma only reads DATABASE_URL to connect; generating the client does not
RUN DATABASE_URL=mysql://build:build@localhost:3306/build npx prisma generate
RUN npm run build

# ---- deps: production node_modules only ----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- migrate: one-off image that applies migrations and seeds (needs the prisma CLI, so dev dependencies) ----
FROM build AS migrate
ENV NODE_ENV=production
CMD ["npx", "prisma", "migrate", "deploy"]

# ---- runtime: the API and the worker run from this same image (different command) ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    TZ=Asia/Kolkata
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/apps/api/main.js"]
