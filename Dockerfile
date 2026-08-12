FROM node:22-alpine

WORKDIR /app

# Sem dependências externas: basta copiar o código.
COPY package.json ./
COPY server.js questions.js store.js ./
COPY public ./public

# Diretório de dados já criado com o dono certo — um volume nomeado do Docker
# herda essa permissão ao ser montado vazio pela primeira vez.
RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000
VOLUME ["/app/data"]

USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
