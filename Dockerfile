FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# DATA_DIR is where the persistent volume is mounted. Everything the app keeps
# lives there: raw responses, the Parquet warehouse and the notes database.
ENV NODE_ENV=production DATA_DIR=/data SCHEDULE_UTC=00:15
EXPOSE 8000
CMD ["sh", "-c", "npx next start -H 0.0.0.0 -p ${PORT:-8000}"]
