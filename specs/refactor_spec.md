# Especificação Técnica de Refatoração MVC

## 1. Arquitetura Geral do Sistema
O objetivo desta refatoração é migrar o backend da aplicação **Logistics Pro** do modelo monolítico atual para o padrão **MVC (Model-View-Controller)**. 

### Diagrama de Relações
```
                   ┌──────────────┐
                   │   Navegador  │ (Admin/Mobile HTML)
                   └──────┬───────┘
                          │ (Requisições HTTP / SSE)
                          ▼
                   ┌──────────────┐
                   │  app/routes  │ (Express Router)
                   └──────┬───────┘
                          │ (Rotas mapeadas)
                          ▼
             ┌─────────────────────────┐
             │    app/controllers      │ (Controladores)
             └────┬───────────────┬────┘
                  │               │
                  ▼               ▼
          ┌──────────────┐ ┌──────────────┐
          │  app/models  │ │ app/services │ (Serviços: Queue, Pipeline)
          └──────┬───────┘ └──────┬───────┘
                 │                │
                 ▼                ▼
          ┌──────────────┐ ┌──────────────┐
          │  coleta.db   │ │  Vision/Gemini│ (APIs Externas)
          │   (SQLite)   │ └──────────────┘
          └──────────────┘
```

---

## 2. Responsabilidades dos Componentes

### 2.1. Camada Model (`app/models/`)
Os models encapsulam todas as operações de banco de dados SQLite. Nenhum SQL cru deve ser executado fora desta camada.

*   **`Pacote.js`**: Operações na tabela `pacotes`.
    *   `create(data)`: Insere um novo pacote.
    *   `update(id, data)`: Atualiza dados de um pacote existente.
    *   `delete(id)`: Remove um pacote por ID.
    *   `findById(id)`: Busca pacote específico.
    *   `findAllToday()`: Busca todos os pacotes coletados hoje.
    *   `findAllByDate(date)`: Consulta pacotes de uma data específica.
    *   `findDuplicate(codigo, date, excludeId)`: Verifica se um código de pacote já foi coletado na data especificada.
    *   `findDistinctClients()`: Retorna lista de remetentes distintos cadastrados.
    *   `findClientReportData(clientList, startDate, endDate)`: Busca dados consolidados para demonstrativo do cliente.
    *   `findConferenceReportData(date, startTime, endTime)`: Busca dados por cliente e plataforma em uma janela de tempo.
    *   `findConferenceTotals(date, startTime, endTime)`: Busca totais por plataforma em uma janela de tempo.
    *   `countByPlataformaAndDate(plataforma, date)`: Conta pacotes de uma plataforma em uma data.
    *   `deleteOlderThan(dateLimit)`: Limpa pacotes mais antigos que o limite (TTL).

*   **`AlertaFila.js`**: Operações na tabela `alertas_fila`.
    *   `create(data)`: Cria um novo alerta de erro na fila (duplicidade/incompleto).
    *   `delete(id)`: Remove alerta.
    *   `findById(id)`: Busca alerta por ID.
    *   `findAll()`: Retorna todos os alertas ativos no painel.
    *   `deleteOlderThan(dateLimit)`: Limpa alertas mais antigos que o limite (TTL).

### 2.2. Camada Controller (`app/controllers/`)
Os controladores recebem as requisições HTTP, realizam validações preliminares, acionam os Models/Services apropriados e formatam as respostas (JSON ou Streams).

*   **`PageController.js`**: Serve arquivos estáticos da camada view (`admin.html`, `mobile.html`).
*   **`UploadController.js`**: Recebe arquivos enviados via Multer e enfileira no `QueueService`.
*   **`DashboardController.js`**: Gerencia dados consolidados do painel e transmissões via SSE (Server-Sent Events) mantendo o registro de clientes conectados.
*   **`PacoteController.js`**: Gerencia o CRUD de pacotes e busca de conflito por código.
*   **`AlertaController.js`**: Gerencia ações do painel de alertas (confirmar correção, deletar, reprocessar via retry).
*   **`ReportController.js`**: Controla geração e transmissão de PDFs do PDFKit de prestação de contas e conferência física.

### 2.3. Camada View (`app/views/`)
Contém arquivos estáticos e templates.
*   **`app/views/public/`**:
    *   `admin.html`: Dashboard administrativa do notebook.
    *   `mobile.html`: Interface operacional de celular.

### 2.4. Serviços (`app/services/`)
Para manter a arquitetura limpa, lógicas complexas que envolvem APIs externas e processamentos assíncronos em background são delegadas a serviços:

*   **`PipelineService.js`**: Contém o acesso a gRPC do Google Vision OCR e SDK do Google Gemini (geração de conteúdo estruturado), integrando os fallbacks automáticos locais.
*   **`QueueService.js`**: Orquestra a fila em memória (FIFO), realiza retentativas em caso de falha de conexão e faz a triagem das etiquetas gerando registros de sucesso (`Pacote`) ou registros de erro na DLQ (`AlertaFila`).

### 2.5. Utilitários e Configurações (`app/utils/`)
*   **`helpers.js`**: Timezone de São Paulo, formatadores e helper de retentativa exponencial com jitter.
*   **`logger.js`**: Interceptador global do console, gravando arquivos de log rotativos na raiz do projeto (`app.log`).
*   **`storage.js`**: Configuração do Multer (armazenamento das fotos no disco rígido).

---

## 3. Fluxo de Dados de Processamento de Imagens

```
Celular ──(POST /api/upload)──> UploadController ──> QueueService (Enfileiramento)
                                                         │
                                               [Fila FIFO: 1 por vez]
                                                         │
                                                         ▼
                                               PipelineService (OCR + Gemini)
                                                         │
                                            ┌────────────┴────────────┐
                                   [Sucesso completo]          [Falha/Conflito]
                                            │                         │
                                            ▼                         ▼
                                       Pacote.create()         AlertaFila.create()
                                            │                         │
                                            └────────────┬────────────┘
                                                         ▼
                                                DashboardController
                                              (Broadcast Evento SSE)
                                                         │
                                                         ▼
                                            Notebook Admin (Atualiza)
```
