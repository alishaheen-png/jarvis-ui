FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

# Build Vite frontend
RUN npm run build

ENV NODE_ENV=production

# Railway provides PORT
CMD ["node", "server/index.js"]
