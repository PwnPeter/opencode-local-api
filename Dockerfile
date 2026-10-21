FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /data
WORKDIR /app
COPY --chown=node:node src/ src/
COPY --chown=node:node scripts/install.py scripts/extract.mjs scripts/verify.mjs scripts/container.sh scripts/
ENV XDG_CONFIG_HOME=/data \
    RELAY_ENVELOPE_FILE=/data/opencode-local-api/envelope.json \
    RELAY_HOST=0.0.0.0 \
    PYTHONDONTWRITEBYTECODE=1
USER node
EXPOSE 4097
ENTRYPOINT ["sh", "scripts/container.sh"]
