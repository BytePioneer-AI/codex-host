FROM node:24-alpine AS build
WORKDIR /app

RUN apk add --no-cache patch
COPY package.json package-lock.json ./
COPY packages/remote-relay/package.json packages/remote-relay/package.json
COPY patches/acme-client@5.4.0.patch patches/acme-client@5.4.0.patch
# Install only this workspace and its TypeScript build tools from the repository lockfile.
RUN node --input-type=commonjs -e '\
  const fs = require("node:fs"); \
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); \
  pkg.workspaces = ["packages/remote-relay"]; \
  pkg.devDependencies = Object.fromEntries( \
    ["typescript", "@types/node", "@types/ws"].map(name => [name, pkg.devDependencies[name]]) \
  ); \
  delete pkg.scripts; \
  fs.writeFileSync("package.json", JSON.stringify(pkg));' \
  && npm ci --ignore-scripts --no-audit --no-fund \
  && patch -p1 -d node_modules/acme-client < patches/acme-client@5.4.0.patch

COPY tsconfig.base.json ./
COPY packages/remote-relay/tsconfig.json packages/remote-relay/tsconfig.json
COPY packages/remote-relay/src packages/remote-relay/src
RUN npm run build --workspace=@codexhost/remote-relay \
  && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/remote-relay/package.json ./packages/remote-relay/package.json
COPY --from=build /app/packages/remote-relay/dist ./packages/remote-relay/dist
RUN chmod +x packages/remote-relay/dist/cli.js \
  && ln -s /app/packages/remote-relay/dist/cli.js /usr/local/bin/codexhost-relay \
  && mkdir /data && chown node:node /data
ENV CODEXHOST_RELAY_DATA_DIR=/data
USER node
EXPOSE 443
ENTRYPOINT ["codexhost-relay"]
