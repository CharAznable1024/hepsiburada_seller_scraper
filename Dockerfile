FROM node:22-bookworm-slim AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --include=dev --audit=false
COPY . ./
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm --quiet set progress=false && npm install --omit=dev --omit=optional --audit=false && npm cache clean --force
COPY --from=builder /usr/src/app/dist ./dist
CMD ["node", "dist/src/main.js"]
