# Logistics Pro - Sistema de Gestão de Coleta de Pacotes

Este repositório contém o código-fonte do **Logistics Pro**, uma aplicação leve e resiliente para gestão local de coleta e recebimento de pacotes de logística reversa (com foco em **Shopee** e **Mercado Livre**). 

A aplicação foi projetada para rodar em hardware de baixo desempenho (ex: notebooks antigos com processadores Core i5 de 2ª geração e 8GB de RAM) e oferece suporte a upload via smartphone, processamento inteligente de etiquetas por IA e um painel de monitoramento em tempo real por eventos.

---

## 🚀 Principais Funcionalidades

### 1. Captura e Upload Móvel (`/mobile`)
*   Interface simplificada adaptada para smartphones operacionais de balcão.
*   Permite fotografar etiquetas de pacotes diretamente pela câmera do celular ou escolher arquivos de imagem.
*   Envio assíncrono instantâneo para a fila do servidor com feedback visual de sucesso imediato.

### 2. Pipeline de Processamento Inteligente (OCR + IA)
*   **Fila FIFO**: Lida com o processamento de imagens de forma sequencial (limite rigoroso de 1 processo ativo por vez) para poupar CPU e RAM do servidor local.
*   **Google Cloud Vision API**: Realiza a extração de texto (OCR) da etiqueta.
*   **Google Gemini 2.5 Flash**: Classifica semanticamente as informações extraídas no formato JSON estruturado, identificando:
    *   *Nome do Remetente/Loja*
    *   *Plataforma de Origem* (com regras estritas de formatação e prefixos)
    *   *Código de Rastreio*
*   **Resiliência a API Keys**: Detecta de forma inteligente chaves de API cruas injetadas incorretamente no lugar de arquivos de credenciais do Google Cloud SDK, contornando falhas do client library e utilizando mocks automáticos se não houver conexão externa.

### 3. Painel Administrativo (`/admin`)
*   **Dashboard**: Cards de métricas diárias consolidadas (Shopee/Mercado Livre) no fuso horário de Brasília (UTC-3), barra de progresso em tempo real da fila e tabela com os últimos 50 pacotes lidos.
*   **Atualização em Tempo Real (Server-Sent Events - SSE)**: Atualização instantânea orientada a eventos. O painel se comunica com o servidor via SSE (`/api/events`), eliminando totalmente o tráfego de requisições de polling (`setInterval`), reduzindo drasticamente o consumo de CPU.
*   **Tela de Alertas Pendentes**: Centraliza os problemas que precisam de revisão do operador (duplicidades diárias de código e leituras incompletas do OCR).
*   **Histórico de Coletas**: Busca retroativa de pacotes salvos no banco por data única.
*   **Preview de Etiqueta Lado a Lado**: Modais de edição e confronto exibem a imagem física da etiqueta enviada pelo celular ao lado dos campos de texto, garantindo precisão na verificação do operador.
*   **Exclusão Física**: O descarte ou exclusão de pacotes duplicados apaga tanto o registro no SQLite quanto o arquivo de imagem no disco físico.

### 4. Relatórios Avançados (PDFKit)
*   **Demonstrativo de Prestação de Contas (Cliente)**: Relatório consolidado em 4 colunas perfeitamente alinhadas (`Data/Hora`, `Remetente Lido`, `Plataforma`, `Código do Pacote`), exibindo os períodos selecionados no padrão `dd-MM-yyyy`.
*   **Conferência de Balcão (Fechamento)**: Relatório compacto em 3 colunas (`Nome do Remetente/Loja`, `Quantidade`, `Plataforma`) com filtragem por janela horária e sem totalizadores consolidados por turno redundantes.
*   **Paginação Inteligente**: Alturas de linhas medidas dinamicamente (`heightOfString`). Caso a tabela ultrapasse o fim da página, gera uma quebra automática e **reimprime os cabeçalhos de coluna** no topo da página seguinte para manter o alinhamento.

### 5. Log de Sistema Persistente (`logger.js`)
*   Gravação nativa de logs do console em arquivo (`app.log`) no fuso horário de Brasília (UTC-3).
*   **Rotação de Logs automática**: No startup, se o arquivo `app.log` ultrapassar 10MB, ele é renomeado para `app.old.log` e um novo log limpo é iniciado, prevenindo estouro de armazenamento local.

---

## 🛠️ Arquitetura e Stack Tecnológica

*   **Runtime**: Node.js (Express)
*   **Banco de Dados**: SQLite (`better-sqlite3` para máxima performance de leitura/escrita e modo WAL ativo)
*   **Persistência de Imagens**: Armazenamento em diretório estático local (`uploads/`)
*   **Visualização**: HTML5 / Vanilla CSS (TailwindCSS dinâmico) / Vanilla Javascript no cliente.
*   **Geração de Relatórios**: PDFKit
*   **Processamento em Tempo Real**: Server-Sent Events (SSE)

---

## ⚙️ Variáveis de Ambiente (`.env`)

Crie um arquivo `.env` na raiz do projeto com as seguintes variáveis:

```env
PORT=3000
GEMINI_API_KEY=SuaChaveDoGeminiAqui
GOOGLE_APPLICATION_CREDENTIALS=SuaChaveDoVisionAquiOuCaminhoDoArquivoJson
UPLOADS_DIR=uploads
DATABASE_PATH=coleta.db
SERVER_IP=localhost
```

---

## 🚀 Como Executar o Projeto

### Ambiente de Desenvolvimento (Docker)
1. Instale o Docker e Docker Compose na sua máquina.
2. Configure o arquivo `.env`.
3. Inicie o container:
   ```bash
   docker-compose up -d --build
   ```
4. O painel estará disponível em `http://localhost:3000/admin` e a tela móvel em `http://localhost:3000/mobile`.

### Ambiente de Produção (Nativo Windows)
Para rodar nativamente em produção sem a sobrecarga do Docker:
1. Certifique-se de ter o **Node.js (LTS)** instalado no notebook Windows.
2. Execute o arquivo **`iniciar.bat`**:
   * O script instalará as dependências (`npm install --only=production`) caso a pasta `node_modules` não exista.
   * Inicializará o servidor Node em segundo plano.
   * Abrirá o navegador padrão automaticamente em `http://localhost:3000/admin`.

---

## 🧪 Testes de Integração

A aplicação possui testes automatizados de fluxo de ponta a ponta (upload, OCR, Gemini, fila, duplicidade, alertas, remoção física, PDFs e TTL).

Para rodar os testes dentro do container Docker:
```bash
docker exec efeps_app_coleta_dev node verify.js
```

Para rodar os testes localmente no Windows:
```cmd
node verify.js
```
*(Nota: O script de testes limpa as tabelas do banco SQLite no setup inicial para garantir que o fluxo de validação execute limpo).*

---

## 🧹 Política de Retenção de Dados (TTL)

A aplicação conta com uma rotina de inicialização automática de TTL (Time to Live) configurada para **60 dias**. A cada inicialização do servidor:
*   Registros de pacotes e alertas com mais de 60 dias de criação são excluídos logicamente do banco de dados.
*   As respectivas imagens das etiquetas armazenadas no disco em `uploads/` são excluídas fisicamente para poupar armazenamento local.
