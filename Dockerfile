# ---- build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production
# LibreOffice lets the server render PowerPoint decks to PDF so Claude sees every
# slide exactly as designed. Build with --build-arg WITH_LIBREOFFICE=false to skip it
# (slides then fall back to text + embedded-image extraction).
ARG WITH_LIBREOFFICE=true
RUN if [ "$WITH_LIBREOFFICE" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends libreoffice-impress libreoffice-writer fonts-dejavu fonts-liberation \
      && rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
ENV PORT=3001
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3001
CMD ["node", "dist-server/server/index.js"]
