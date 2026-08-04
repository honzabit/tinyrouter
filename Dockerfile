FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
ARG TARGETARCH
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN case "$TARGETARCH" in \
      amd64) BUN_TARGET=bun-linux-x64-musl ;; \
      arm64) BUN_TARGET=bun-linux-arm64-musl ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun build src/main.ts --compile --target="$BUN_TARGET" --outfile dist/tinyrouter

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
ARG TARGETARCH
COPY --from=build /app/dist/tinyrouter /usr/local/bin/tinyrouter
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/tinyrouter"]
CMD ["--config", "/etc/tinyrouter/tinyrouter.yaml"]
