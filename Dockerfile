FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY client/package.json client/
COPY server/package.json server/
COPY client client
COPY server server
RUN cd client && npm install && npm run build \
 && cd ../server && npm install --omit=optional || npm install
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]
