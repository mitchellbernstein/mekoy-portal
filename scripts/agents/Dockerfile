FROM mcr.microsoft.com/playwright:v1.64.1-noble
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng python3 ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/demo && npm install --prefix /opt/demo --omit=dev playwright@1.64.1
COPY capture.mjs container.mjs /opt/demo/
USER pwuser
WORKDIR /app
