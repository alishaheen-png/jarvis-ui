FROM node:20-slim
WORKDIR /app
ARG CACHEBUST=1
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "server/index.js"]
