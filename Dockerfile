FROM node:20

# Instala ferramentas adicionais, se necessário
WORKDIR /app

# Copia package.json e package-lock.json
COPY package*.json ./

# Instala todas as dependências (incluindo devDependencies)
RUN npm install

# O código em desenvolvimento será montado via volume,
# mas copiamos por segurança caso rode sem compose.
COPY . .

# Expõe a porta 3000 do container
EXPOSE 3000

# Executa o servidor em modo desenvolvimento com nodemon
CMD ["npm", "run", "dev"]
