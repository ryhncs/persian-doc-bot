FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production

# Webhook mode listens on PORT; harmless if the deploy uses polling instead.
EXPOSE 3000

CMD ["node", "src/bot.js"]
