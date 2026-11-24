FROM node:24-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./

RUN mkdir -p /data && chown node:node /data
USER node

ENV PORT=3100 DATA_DIR=/data
VOLUME /data
EXPOSE 3100

CMD ["node", "server.js"]
