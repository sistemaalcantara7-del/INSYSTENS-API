# Build Stage
FROM node:20-bookworm-slim AS builder

WORKDIR /usr/src/app

# Instala dependências de compilação essenciais no Debian
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copia configurações de dependências do monorepo
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/importer/package.json ./apps/importer/

# Instala todas as dependências do monorepo
RUN npm ci

# Copia todo o código fonte do projeto
COPY . .

# Gera o Prisma Client apontando para o schema da API
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy?schema=public"
ENV DIRECT_URL="postgresql://dummy:dummy@localhost:5432/dummy?schema=public"
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma

# Compila o projeto da API
RUN npm run build -w @electoral-api/api

# Limpa e instala apenas dependências de produção para otimizar tamanho
RUN rm -rf node_modules && npm ci --only=production
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy?schema=public"
ENV DIRECT_URL="postgresql://dummy:dummy@localhost:5432/dummy?schema=public"
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma

# Runtime Stage
FROM node:20-bookworm-slim

WORKDIR /usr/src/app

# Instala dependências compartilhadas nativas de produção (OpenSSL)
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copia build e dependências do builder
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package.json ./package.json
COPY --from=builder /usr/src/app/apps/api/dist ./apps/api/dist
COPY --from=builder /usr/src/app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /usr/src/app/apps/api/prisma ./apps/api/prisma

ENV NODE_ENV=production
ENV PORT=80

EXPOSE 80

CMD ["node", "apps/api/dist/server.js"]
