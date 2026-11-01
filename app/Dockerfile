FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY plugins ./plugins
RUN mkdir -p /data && chown node:node /data
USER node
ENV VITRINE_DATA_DIR=/data PORT=3400
EXPOSE 3400
VOLUME /data
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
