# Node 22 (LTS em manutenção): o 20 saiu de suporte em abril/2026, e o
# nodemailer 10 exige Node >= 20.
FROM node:22-bookworm-slim

WORKDIR /app

# O binário de engine do Prisma precisa do OpenSSL "de verdade" instalado no
# sistema (a variante Alpine deste Dockerfile falhava ao detectar a versão de
# libssl e quebrava "prisma migrate deploy" em produção) — Debian slim é a
# base que o próprio Prisma recomenda por evitar essa classe de problema.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copia primeiro o necessário para instalar dependências e gerar o Prisma
# Client (schema.prisma precisa estar presente antes do "npm ci", já que o
# postinstall do package.json roda "prisma generate" automaticamente) —
# isso também aproveita o cache de camadas do Docker: o `npm ci` só roda de
# novo se package.json/lock ou o schema mudarem, não a cada alteração de código.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# Agora copia o restante do código-fonte.
COPY . .

EXPOSE 3000

# Aplica migrations pendentes a cada subida do container (idempotente — não
# faz nada se já estiver tudo aplicado) e então inicia o servidor. Não roda
# seed automaticamente: isso é feito uma vez, manualmente, via
# "docker compose exec app npm run seed".
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
