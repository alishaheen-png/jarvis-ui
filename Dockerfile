FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Remove devDependencies after build
RUN npm prune --production

ENV NODE_ENV=production

CMD ["node", "server/index.js"]
