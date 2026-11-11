# AI sidecar — provider bridge + proposal builder. Minimal G2 skeleton; G3/G4 fill
# in Ollama/OpenAI/compat logic. Listens only on the compose network (no host port).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# no secrets baked; all via runtime env (AI_GATEWAY_SECRET, *_API_KEY, urls)
COPY services/ai-sidecar/package.json ./
RUN npm install --omit=dev
COPY services/ai-sidecar/src ./src
USER node
EXPOSE 8090
CMD ["node", "src/server.mjs"]
