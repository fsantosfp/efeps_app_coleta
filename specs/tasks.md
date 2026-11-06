# Plano de Tarefas - Refatoração MVC

Este arquivo contém a lista de tarefas granulares que serão seguidas durante o refactoring.

- `[ ]` Não iniciado
- `[/]` Em andamento
- `[x]` Concluído

---

## 📅 Fase 1: Infraestrutura Básica e Utilitários
- [x] Criar/Mapear `app/utils/logger.js` (ajustar caminhos para salvar logs no diretório raiz `app.log`).
- [x] Criar `app/utils/helpers.js` a partir das funções em `utils.js` (conversão de timezone de SP, helpers de retentativa, checagem de erros transientes).
- [x] Criar `app/utils/storage.js` configurando o Multer e a exportação do caminho do diretório de uploads.
- [x] Mover/copiar arquivos estáticos da view:
    - [x] Garantir que `app/views/public/admin.html` existe e está atualizado.
    - [x] Copiar `public/mobile.html` para `app/views/public/mobile.html`.

## 🗄️ Fase 2: Configuração de Banco de Dados e Camada Model
- [x] Criar `app/database.js` para gerenciar a inicialização das tabelas do banco de dados (SQLite via `better-sqlite3`), ajustando o caminho relativo da base de dados para a raiz.
- [x] Criar o Model `app/models/Pacote.js` com os métodos:
    - [x] `create(data)`
    - [x] `update(id, data)`
    - [x] `delete(id)`
    - [x] `findById(id)`
    - [x] `findAllToday()`
    - [x] `findAllByDate(date)`
    - [x] `findDuplicate(codigo, date, excludeId)`
    - [x] `findDistinctClients()`
    - [x] `findClientReportData(clientes, dataInicio, dataFim)`
    - [x] `findConferenceReportData(data, horaInicio, horaFim)`
    - [x] `findConferenceTotals(data, horaInicio, horaFim)`
    - [x] `countByPlataformaAndDate(plataforma, date)`
    - [x] `deleteOlderThan(dateLimit)`
- [x] Criar o Model `app/models/AlertaFila.js` com os métodos:
    - [x] `create(data)`
    - [x] `delete(id)`
    - [x] `findById(id)`
    - [x] `findAll()`
    - [x] `deleteOlderThan(dateLimit)`

## 🧠 Fase 3: Camada de Serviços (Services)
- [x] Criar `app/services/PipelineService.js` contendo a lógica de processamento de OCR (Google Vision API) e classificação semântica (Google Gemini 1.5 Flash), preservando fallbacks e simulações.
- [x] Criar `app/services/QueueService.js` contendo a fila de processamento assíncrona, lógica de triagem, persistência usando os novos Models (`Pacote`, `AlertaFila`) e emissão de eventos.

## 🕹️ Fase 4: Camada de Controladores (Controllers)
- [x] Criar `app/controllers/PageController.js` para servir as views.
- [x] Criar `app/controllers/UploadController.js` para gerenciar o upload inicial de imagens.
- [x] Criar `app/controllers/DashboardController.js` para lidar com estatísticas do painel e controle de SSE (Server-Sent Events).
- [x] Criar `app/controllers/PacoteController.js` para lidar com as ações CRUD, histórico, busca de conflito e listagem de clientes.
- [x] Criar `app/controllers/AlertaController.js` para lidar com descarte, confirmação e retentativas dos alertas da DLQ.
- [x] Criar `app/controllers/ReportController.js` para gerenciar a emissão dos PDFs através do `pdfkit`.

## 🕸️ Fase 5: Rotas e Ponto de Entrada (Server.js)
- [x] Criar `app/routes.js` contendo todos os endpoints HTTP mapeados aos controladores correspondentes.
- [x] Atualizar `app/server.js` para:
    - [x] Inicializar o logger global.
    - [x] Inicializar o banco de dados.
    - [x] Configurar os parsers de corpo de requisição (`express.json`, `express.urlencoded`).
    - [x] Configurar o roteamento das páginas estáticas e da pasta de uploads.
    - [x] Carregar as rotas (`app/routes.js`).
    - [x] Ouvir eventos do `QueueService` para disparar transmissões automáticas via SSE.
    - [x] Iniciar a rotina automática TTL de 60 dias.
    - [x] Abrir o servidor Express na porta de escuta configurada.

## 🧪 Fase 6: Integração, Limpeza e Validação
- [x] Atualizar scripts em `package.json` para rodar `app/server.js`.
- [x] Testar a aplicação rodando `npm run dev` ou `npm start` em background.
- [x] Executar o script de testes de integração `node verify.js` e assegurar que todos os testes passem com 100% de sucesso.
- [x] Limpar arquivos legados da raiz (`database.js`, `logger.js`, `pipeline.js`, `queue.js`, `server.js`, `utils.js` - após confirmar o funcionamento e fazer backups se necessário).
- [x] Criar o walkthrough final documentando a reestruturação concluída.
