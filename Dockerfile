FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY voice_farm.js .

EXPOSE 8080

CMD ["node", "voice_farm.js"]
