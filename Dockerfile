FROM oven/bun:1 AS frontend
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
COPY build.ts tsconfig.json ./
RUN bun run build

FROM golang:1.25 AS backend
WORKDIR /app/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
COPY --from=frontend /app/server/dashboard/ ./dashboard/
RUN CGO_ENABLED=1 go build -o /blosmap-server .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=backend /blosmap-server /usr/local/bin/
# Install pmtiles CLI
ADD https://github.com/protomaps/go-pmtiles/releases/download/v1.22.3/go-pmtiles_1.22.3_Linux_x86_64.tar.gz /tmp/
RUN tar -xzf /tmp/go-pmtiles_1.22.3_Linux_x86_64.tar.gz -C /usr/local/bin/ pmtiles && rm /tmp/*.tar.gz

EXPOSE 3544
VOLUME /data
CMD ["blosmap-server"]
