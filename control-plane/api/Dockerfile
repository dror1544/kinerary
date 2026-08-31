FROM node:20-alpine AS build
WORKDIR /app
COPY control-plane/api/package.json control-plane/api/package-lock.json ./
RUN npm ci
COPY control-plane/api/tsconfig.json ./
COPY control-plane/api/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY control-plane/api/package.json control-plane/api/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY control-plane/db/migrations ./migrations
USER node
CMD ["node", "dist/server.js"]
