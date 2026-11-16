FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY mcp.js shared-routes.js ./
CMD ["node", "mcp.js"]
