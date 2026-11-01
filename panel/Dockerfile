FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY panel ./panel
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "panel/main.mjs"]
