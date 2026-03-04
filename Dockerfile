FROM node:18-slim

# Install all compilers: GCC (C), G++ (C++), JDK 17 (Java), Python 3
RUN apt-get update && \
    apt-get install -y gcc g++ default-jdk python3 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

EXPOSE 5000

CMD ["node", "server.js"]
