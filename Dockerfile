FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
ENV PORT=10099
ENV SLUICE_DATA_DIR=/app/data
EXPOSE 10099
CMD ["node", "src/server.js"]
