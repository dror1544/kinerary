FROM node:20-alpine AS build
WORKDIR /app
COPY control-plane/api/package.json control-plane/api/package-lock.json ./
RUN npm ci
COPY control-plane/api/tsconfig.json ./
COPY control-plane/api/src ./src
# model-runner.ts imports "../../../shared/child-env.js" (#284) -- three
# levels up from control-plane/api/src on the real filesystem is the repo
# root, where shared/ actually lives; inside this image, /app/src is three
# levels up from /shared, not from anything else, so shared/ has to land
# there (an absolute COPY destination, a sibling of /app, not nested under
# it) for that relative import to resolve at all. Needed in BOTH stages: tsc
# needs shared/child-env.d.ts here to typecheck; the runtime stage below
# needs the same plain .js file at the same path for the compiled import to
# resolve when node actually runs it.
COPY shared /shared
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY control-plane/api/package.json control-plane/api/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY control-plane/db/migrations ./migrations
COPY shared /shared
USER node
CMD ["node", "dist/server.js"]
