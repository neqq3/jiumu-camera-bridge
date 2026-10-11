ARG NODE_BASE=node:24.21.0-bookworm-slim
FROM ${NODE_BASE}
ARG MEDIA_READY=0
ARG BUILD_VERSION=0.1.0
ARG BUILD_ARCH="amd64|aarch64"
LABEL io.hass.version="${BUILD_VERSION}" io.hass.type="app" io.hass.arch="${BUILD_ARCH}"
RUN if [ "$MEDIA_READY" != 1 ]; then \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg && \
      case "$(dpkg --print-architecture)" in \
        amd64) asset=amd64; checksum=32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6 ;; \
        arm64) asset=arm64; checksum=359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50 ;; \
        *) exit 1 ;; esac && \
      curl -fsSL "https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_linux_${asset}" -o /usr/local/bin/go2rtc && \
      echo "$checksum  /usr/local/bin/go2rtc" | sha256sum -c - && chmod 755 /usr/local/bin/go2rtc && \
      rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /app
COPY lib/ ./lib/
COPY public/ ./public/
COPY server.cjs ./
COPY licenses/ /usr/share/licenses/jiumu-camera-bridge/
COPY THIRD_PARTY.md /usr/share/licenses/jiumu-camera-bridge/THIRD_PARTY.md
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 18082 18554
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "const n=require('net').connect(18082,'127.0.0.1',()=>{n.destroy();process.exit(0)});n.on('error',()=>process.exit(1))"
CMD ["node","server.cjs"]
