FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app/server
COPY server/package.json .
RUN npm install --production --silent
COPY server/*.js ./
COPY shared /app/shared
CMD ["node", "server.js"]
