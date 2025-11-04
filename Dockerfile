FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN apk add --no-cache ffmpeg \
    && npm ci --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
