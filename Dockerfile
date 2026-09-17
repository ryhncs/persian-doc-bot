FROM node:20-slim

WORKDIR /app

# Ghostscript is required for PDF compression (src/services/pdfCompress.js
# shells out to the `gs` binary). Everything else in the bot is pure JS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ghostscript \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production

# Webhook mode listens on PORT; harmless if the deploy uses polling instead.
EXPOSE 3000

CMD ["node", "src/bot.js"]
