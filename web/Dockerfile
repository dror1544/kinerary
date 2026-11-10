# Build with the REPOSITORY ROOT as the context:
#   docker build -f web/Dockerfile -t <tag> .
# web/src/styles.css imports ../../shared/brand-tokens.css, which sits outside web/, so a
# build with web/ as its context fails at `npm run build` ("Unable to resolve @import").
FROM node:20-alpine AS build
WORKDIR /app
# From /app/src, "../../shared" is /shared. Only the file the stylesheet imports.
COPY shared/brand-tokens.css /shared/brand-tokens.css
COPY web/ ./
# A node_modules copied in from a developer's checkout must not stand in for the locked install.
RUN rm -rf node_modules && npm ci
RUN npm run build

FROM nginx:stable-alpine
# nginx.conf is a template (see its header). The image's entrypoint renders every
# /etc/nginx/templates/*.template into /etc/nginx/conf.d/ at start, substituting ONLY the
# variables named by the filter below.
#   CONTROL_PLANE_API_ORIGIN  where /v1 is proxied. The default keeps a bare `docker run`
#                             working as before; a deployment overrides it (compose does).
#   NGINX_ENTRYPOINT_LOCAL_RESOLVERS  makes the entrypoint export NGINX_LOCAL_RESOLVERS from
#                             /etc/resolv.conf, which the template's `resolver` line uses.
ENV CONTROL_PLANE_API_ORIGIN=http://control-plane-api:4310 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_FILTER='^(CONTROL_PLANE_API_ORIGIN|NGINX_LOCAL_RESOLVERS)$'
COPY web/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
