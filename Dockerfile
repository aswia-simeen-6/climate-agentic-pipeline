# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage production build for the Aurora ESG Agentic Pipeline backend.
#
# Stages:
#   deps    — Install all npm dependencies (cached unless package*.json changes)
#   builder — Copy source and compile TypeScript to ./dist
#   runner  — Minimal runtime image: dist + prod node_modules + non-root user
#
# Environment variables required at runtime (set via secret manager / env injection):
#   DATABASE_URL          PostgreSQL connection string (mandatory)
#   ANTHROPIC_API_KEY     Anthropic API key for P-003 LLM node (mandatory)
#   PORT                  HTTP port (default: 3000)
#   HOST                  Bind address (default: 0.0.0.0)
#   NODE_ENV              Should be "production"
#   LLM_MODEL             Defaults to claude-3-5-sonnet-20241022
#   LLM_MAX_TOKENS        Defaults to 1024
#   LLM_TEMPERATURE       Defaults to 0.1
#   METHODOLOGY_VERSION   Defaults to v1.0.0
# ─────────────────────────────────────────────────────────────────────────────

# ════════════════════════════════════════════════════════
# Stage 1 — deps
# Install ALL node_modules (including devDependencies for
# the build stage).  This layer is cached independently.
# ════════════════════════════════════════════════════════
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only package manifests to maximise Docker layer cache hits.
COPY package.json package-lock.json ./

# --frozen-lockfile ensures reproducible installs; CI-grade determinism.
RUN npm ci --frozen-lockfile

# ════════════════════════════════════════════════════════
# Stage 2 — builder
# Compile TypeScript to CommonJS in ./dist.
# ════════════════════════════════════════════════════════
FROM node:20-alpine AS builder

WORKDIR /app

# Bring in installed dependencies from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy the full source tree (honoured by .dockerignore).
COPY . .

# tsc emits to ./dist as configured in tsconfig.json (outDir: ./dist).
RUN npm run build

# ════════════════════════════════════════════════════════
# Stage 3 — runner
# Minimal runtime image.  Only production artefacts are
# copied; devDependencies are excluded.
# ════════════════════════════════════════════════════════
FROM node:20-alpine AS runner

# Install only the OS packages required at runtime.
# dumb-init provides proper PID-1 signal handling for Node processes.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Create a dedicated non-root user and group for security hardening.
RUN addgroup --system --gid 1001 nodegroup \
 && adduser  --system --uid 1001 --ingroup nodegroup nodeuser

# Install only production dependencies in a clean node_modules.
COPY package.json package-lock.json ./
RUN npm ci --frozen-lockfile --omit=dev

# Copy the compiled output from the builder stage.
COPY --from=builder /app/dist ./dist

# Restrict file ownership to the non-root user.
RUN chown -R nodeuser:nodegroup /app

# Switch to the non-root user.
USER nodeuser

# Expose the default HTTP port.
EXPOSE 3000

# Runtime environment defaults (overridden by orchestrator env injection).
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Use dumb-init as PID 1 to ensure SIGTERM is forwarded to the Node process,
# enabling the graceful shutdown handler in src/server.ts to run.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
