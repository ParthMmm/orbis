# Cobalt 11.7.1 vendors youtubei.js 17.0.1. Every client that version can reach
# (IOS, MWEB, ANDROID_VR, TV_SIMPLY) returns a stream URL YouTube refuses to
# serve past roughly its first MiB: any later range comes back 403, so no chunk
# sequence can assemble a file and cobalt's reader exits with an empty tunnel.
#
# youtubei.js 18.0.0 adds the VISIONOS client. Its URLs are unrestricted, and
# cobalt's reader handles them without change (HEAD returns 200 with a length,
# and its 8 MiB ranges return 206). The only difference this layer makes is the
# vendored client library, so it is a dependency swap rather than a code patch.
FROM ghcr.io/imputnet/cobalt:11@sha256:df14a3b3fe4390d4e1c2d4761ed58981d34aa5fc82d0df2091bab890e7dfaa8b

# The release that introduced the VISIONOS client. Bump only with new evidence.
ARG YOUTUBEI_VERSION=18.0.0

# /app belongs to node and the image runs as node, so the swap needs root.
USER root

RUN set -eu; \
    export npm_config_cache=/tmp/npm-cache; \
    mkdir -p /tmp/youtubei; \
    cd /tmp/youtubei; \
    npm install --no-audit --no-fund --loglevel=error "youtubei.js@${YOUTUBEI_VERSION}"; \
    target=/app/node_modules/.pnpm/youtubei.js@17.0.1/node_modules/youtubei.js; \
    rm -rf "$target"; \
    mkdir -p "$target/node_modules"; \
    cp -r /tmp/youtubei/node_modules/youtubei.js/. "$target"; \
    cp -r /tmp/youtubei/node_modules/fflate "$target/node_modules/"; \
    cp -r /tmp/youtubei/node_modules/meriyah "$target/node_modules/"; \
    cp -r /tmp/youtubei/node_modules/@bufbuild "$target/node_modules/"; \
    rm -rf /tmp/youtubei /tmp/npm-cache; \
    chown -R node:node "$target"

USER node
