# CareerVector alt-relay — Bun-based stateless WebSocket relay.
# Single-stage build: zero runtime dependencies, just the Bun stdlib.

FROM oven/bun:1.2-alpine
WORKDIR /app

# Copy source and config files.
COPY src ./src
COPY package.json tsconfig.json ./

# Build a self-contained single-file bundle (no bun install needed).
RUN bun build src/index.ts --target=bun --outfile=dist/index.js

# PORT is read at runtime; default 8787.
ENV PORT=8787
EXPOSE 8787

CMD ["bun", "run", "dist/index.js"]
