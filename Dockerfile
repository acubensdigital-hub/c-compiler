FROM node:18-slim

# Install GCC compiler
RUN apt-get update && apt-get install -y gcc g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

EXPOSE 5000

CMD ["node", "server.js"]
