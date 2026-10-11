# SPDX-License-Identifier: Apache-2.0
# Experimental standalone service; no media tools, Android SDK or vendor network calls.
ARG NODE_BASE=node:24.21.0-bookworm-slim
FROM ${NODE_BASE}
WORKDIR /app
COPY lib/binding-codec.cjs lib/binding-lock.cjs lib/binding-state.cjs lib/binding-service.cjs ./lib/
COPY local-binding.cjs binding-healthcheck.cjs ./
RUN command -v flock >/dev/null && chmod 0755 /app /app/lib && chmod 0644 /app/*.cjs /app/lib/*.cjs
USER 1000:1000
ENV NODE_ENV=production
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s CMD ["node", "binding-healthcheck.cjs"]
CMD ["node", "local-binding.cjs", "/config/binding.json"]
