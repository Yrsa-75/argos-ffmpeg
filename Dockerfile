FROM node:20-slim

# Install FFmpeg + fonts for subtitle rendering
RUN apt-get update && \
    apt-get install -y ffmpeg fonts-liberation fonts-dejavu-core && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .

EXPOSE 4000

CMD ["node", "server.js"]
