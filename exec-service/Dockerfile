# Build stage
FROM golang:1.22-alpine AS builder

WORKDIR /build

COPY go.mod go.sum* ./
RUN go mod download 2>/dev/null || true

COPY . .
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -o /build/server ./cmd/server

# Runtime stage
FROM alpine:3.19

RUN apk add --no-cache ca-certificates curl docker-cli

WORKDIR /app
COPY --from=builder /build/server /app/server

EXPOSE 8081

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:8081/health || exit 1

ENTRYPOINT ["/app/server"]
