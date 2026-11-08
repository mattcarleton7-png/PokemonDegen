FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node","server.js"]
