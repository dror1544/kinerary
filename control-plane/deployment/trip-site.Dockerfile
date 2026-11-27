# One trip's site as a container (placement `vm-container`; docs/specs/sprint-9/x-trip-vm-container-placement.md).
#
# The image carries only code: a sealed release tree's server/, site/ and shared/, with their
# node_modules installed here. The trip's state lives in a mounted directory (/trip-store).
# nginx on :8080 serves site/ and proxies the API to node on :3000, as in an LXC; the nginx
# `server` block is the same file the LXC bootstrap writes (provisioning/trip-site-nginx.conf).
#
# Build context: the release tree (it holds server/, site/, shared/). The deployment's own files
# come from a second, named context, `tool`, a checkout of this repository. The image's tag is
# `trip-site:<release digest>`, so the same release is the same image:
#
#   docker build -f control-plane/deployment/trip-site.Dockerfile \
#     --build-context tool=<repo checkout> -t trip-site:<digest> <release tree>
#
# Run it as a fixed non-root uid (TRIP_CONTAINER_UID, default 10001) with the trip's directory
# mounted at /trip-store. It refuses to start unless TRIP.txt and .env are in that mount.
ARG NODE_IMAGE=node:20-bookworm-slim

# better-sqlite3 and sharp are native modules: npm builds them when no prebuilt binary matches,
# which needs a compiler. The LXC bootstrap installs build-essential for the same reason.
FROM ${NODE_IMAGE} AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /deps
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
ARG TRIP_CONTAINER_UID=10001
ENV TRIP_CONTAINER_UID=${TRIP_CONTAINER_UID} \
    NODE_ENV=production \
    TRIP_STORE_DIR=/trip-store \
    APP_DIR=/opt/kinerary

# curl is the bridge check's probe (`docker exec ... curl`) and the healthcheck's.
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/* /etc/nginx/conf.d/* \
 && useradd --system --uid ${TRIP_CONTAINER_UID} --no-create-home --shell /usr/sbin/nologin trip \
 && mkdir -p /opt/kinerary /trip-store

# The same layout an LXC has under /opt/kinerary, so the shared nginx config's `root` is right.
WORKDIR /opt/kinerary
COPY server ./server
COPY shared ./shared
COPY site ./site
# A tree's own node_modules (a local build) never wins over the ones installed here.
RUN rm -rf /opt/kinerary/server/node_modules
COPY --from=deps /deps/node_modules ./server/node_modules

# What a container writes, it writes under /trip-store or /tmp, never here; so nginx's `/avatars`
# directory is a link into the mount, made now because the code tree is read-only to the uid.
RUN ln -sfn /trip-store/media/avatars /opt/kinerary/site/avatars

COPY --from=tool provisioning/trip-site-nginx.conf /etc/nginx/trip-site.conf
COPY --from=tool control-plane/deployment/trip-site-nginx-main.conf /etc/nginx/trip-site-nginx-main.conf
COPY --from=tool --chmod=0755 control-plane/deployment/trip-site-entrypoint.sh /usr/local/bin/trip-site-entrypoint

USER ${TRIP_CONTAINER_UID}
WORKDIR /opt/kinerary/server
VOLUME ["/trip-store"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/trip-site-entrypoint"]
