FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY src/ ./src/
COPY dashboard/ ./dashboard/

RUN mkdir -p /data && chmod 755 /data

EXPOSE 4300

ENV PORT=4300
ENV DATA_DIR=/data

CMD ["node", "src/server.js"]
