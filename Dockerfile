FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npx vite build

RUN npm prune --production

ENV NODE_ENV=production

CMD ["node", "server/index.js"]
