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
# The musl build links against the C++ runtime; without libstdc++ the
# executable builds fine but dies at startup on missing ABI symbols.
RUN apk add --no-cache ca-certificates libstdc++
ARG TARGETARCH
COPY --from=build /app/dist/tinyrouter /usr/local/bin/tinyrouter
USER 65532:65532
EXPOSE 8080
# The gateway binds loopback by default, which inside a container means a
# published port reaches nothing. The example config reads this variable, so
# the image widens the bind without the operator editing their file.
ENV TINYROUTER_HOST=0.0.0.0
ENTRYPOINT ["/usr/local/bin/tinyrouter"]
CMD ["--config", "/etc/tinyrouter/tinyrouter.yaml"]
