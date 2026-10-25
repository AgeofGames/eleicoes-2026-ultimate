FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --chown=node:node package.json server.mjs analytics.mjs start-container.mjs ./
COPY --chown=node:node public ./public
EXPOSE 3000
CMD ["node", "start-container.mjs"]
