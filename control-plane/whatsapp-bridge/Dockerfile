# The WhatsApp bridge sidecar: one process, one WhatsApp session, loopback HTTP.
# Built from this directory (`docker build control-plane/whatsapp-bridge`) and
# tagged kinerary-cp/whatsapp-bridge:<rev> by the release tool, only on a VM that
# has switched WhatsApp on (docs/control-plane-vm-deployment.md, "WhatsApp").
#
# What is NOT in the image, on purpose:
#   - the session. It is a credential (full control of the WhatsApp account), so it
#     is a bind mount the deployment provides at /session and never a layer;
#   - the secret. It arrives as a file (--secret-file), never an argument or an
#     environment variable;
#   - the tests, the dev dependencies and any git metadata (.dockerignore).
#
# `node` is uid/gid 1000. The session directory and the secret file on the host
# must belong to the uid the container runs as (compose.vm.whatsapp.yml `user:`).
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
# Arguments only: `--session /session --port <p> --secret-file <f>` to serve,
# `--session /session --pair-only` to link the phone.
ENTRYPOINT ["node", "src/bridge.js"]
