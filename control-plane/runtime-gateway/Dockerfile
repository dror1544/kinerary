FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
USER node
EXPOSE 4320
CMD ["node", "server.js"]
