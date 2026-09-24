FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# node:alpine 的 node 用户为 uid 1000，与宿主机 claw 一致，绑定挂载目录可直接写入
USER node
EXPOSE 8899
CMD ["node", "src/server.js"]
