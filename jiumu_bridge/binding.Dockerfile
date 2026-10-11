# SPDX-License-Identifier: Apache-2.0
# Experimental standalone service; no media tools, Android SDK or vendor network calls.
ARG NODE_BASE=node:24.21.0-bookworm-slim
FROM ${NODE_BASE}
WORKDIR /app
COPY lib/binding-codec.cjs lib/binding-state.cjs lib/binding-service.cjs ./lib/
COPY local-binding.cjs ./
ENV NODE_ENV=production
CMD ["node", "local-binding.cjs", "/config/binding.json"]
