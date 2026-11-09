# Judge0 1.13.1 plus the exact runtime Bekor's harness checks (packages/runner/src/harness.ts):
# /usr/local/bekor/bin/node == v24.22.1 and /usr/local/bekor/node_modules/.bin/tsc == 7.0.2.
# Submissions use Judge0 language 89 ("Multi-file program") with Bekor's compile/run scripts.
# UNVERIFIED: this image has not run a real submission (see guides/runner.md).
FROM docker.io/judge0/judge0:1.13.1@sha256:6b5d6a66aa19a8e878a52ea3c6a560afc1086734d96e2885b561fd5c6018f082
USER root
ARG NODE_VERSION=24.22.1
ARG NODE_SHA256=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
ARG TYPESCRIPT_VERSION=7.0.2
RUN set -eux; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /usr/local/bekor; \
    tar -xJf /tmp/node.tar.xz -C /usr/local/bekor --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    /usr/local/bekor/bin/npm install --prefix /usr/local/bekor --no-audit --no-fund \
      --save-exact "typescript@${TYPESCRIPT_VERSION}"; \
    /usr/local/bekor/bin/npm cache clean --force; \
    test "$(/usr/local/bekor/bin/node --version)" = "v${NODE_VERSION}"; \
    test "$(/usr/local/bekor/bin/node /usr/local/bekor/node_modules/.bin/tsc --version)" = "Version ${TYPESCRIPT_VERSION}"; \
    chmod -R a+rX,go-w /usr/local/bekor
USER judge0
