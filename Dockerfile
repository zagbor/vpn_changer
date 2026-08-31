# Build stage
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /bin/bot ./cmd/bot

# Runtime stage
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=build /bin/bot /app/bot
ENV STORE_PATH=/app/data/state.json
VOLUME ["/app/data"]
ENTRYPOINT ["/app/bot"]
