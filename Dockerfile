FROM node:24-bookworm-slim AS app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4783 MEDIA_ROOT=/data/media
EXPOSE 4783
CMD ["npm", "start"]
