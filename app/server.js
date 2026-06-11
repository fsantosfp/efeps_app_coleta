// Inicializa o logger para interceptar console.log globalmente
require('./utils/logger');

const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { initDb } = require('./database');
const { queueEvents } = require('./services/QueueService');
const DashboardController = require('./controllers/DashboardController');
const { getUploadsDir } = require('./utils/storage');
const routes = require('./routes');
const { getSaoPauloDate } = require('./utils/helpers');
const Pacote = require('./models/Pacote');
const AlertaFila = require('./models/AlertaFila');

const app = express();
const PORT = process.env.PORT || 3000;

// Inicialização do Banco de Dados
initDb();

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos do front-end (Views)
app.use(express.static(path.resolve(__dirname, 'views', 'public')));
// Servir arquivos de uploads
app.use('/uploads', express.static(getUploadsDir()));

// Carrega as rotas da aplicação
app.use(routes);

// Escuta eventos da fila e notifica clientes via SSE em tempo real
queueEvents.on('process-complete', () => {
  DashboardController.broadcastEvent({ type: 'dashboard-update' });
});

// =========================================================================
// ROTINA TTL: Exclui registros e imagens físicas com mais de 60 dias
// =========================================================================
function runTtlCleanup() {
  console.log('[TTL] Iniciando verificação de arquivos expirados (TTL 60 dias)...');
  try {
    const sixtyDaysAgo = new Date(new Date().getTime() - 60 * 24 * 60 * 60 * 1000);
    const dateLimit = getSaoPauloDate(sixtyDaysAgo);

    // 1. Limpeza de Pacotes
    const pacotesExpirados = Pacote.findOlderThan(dateLimit);

    let deletedFilesCount = 0;
    pacotesExpirados.forEach(pkg => {
      if (pkg.caminho_imagem) {
        const absolutePath = path.isAbsolute(pkg.caminho_imagem)
          ? pkg.caminho_imagem
          : path.resolve(__dirname, '..', pkg.caminho_imagem);
        if (fs.existsSync(absolutePath)) {
          try {
            fs.unlinkSync(absolutePath);
            deletedFilesCount++;
          } catch (err) {
            console.error(`[TTL] Erro ao deletar imagem de pacote ${absolutePath}:`, err.message);
          }
        }
      }
    });

    const delPacotes = Pacote.deleteOlderThan(dateLimit);
    console.log(`[TTL] Limpeza de pacotes concluída. ${delPacotes.changes} registros removidos. ${deletedFilesCount} arquivos de imagem deletados.`);

    // 2. Limpeza de Alertas da Fila
    const alertasExpirados = AlertaFila.findOlderThan(dateLimit);

    let deletedAlertFilesCount = 0;
    alertasExpirados.forEach(alert => {
      if (alert.caminho_imagem_nova) {
        const absolutePath = path.isAbsolute(alert.caminho_imagem_nova)
          ? alert.caminho_imagem_nova
          : path.resolve(__dirname, '..', alert.caminho_imagem_nova);
        if (fs.existsSync(absolutePath)) {
          try {
            fs.unlinkSync(absolutePath);
            deletedAlertFilesCount++;
          } catch (err) {
            console.error(`[TTL] Erro ao deletar imagem de alerta ${absolutePath}:`, err.message);
          }
        }
      }
    });

    const delAlertas = AlertaFila.deleteOlderThan(dateLimit);
    console.log(`[TTL] Limpeza de alertas concluída. ${delAlertas.changes} registros removidos. ${deletedAlertFilesCount} arquivos de imagem deletados.`);

  } catch (error) {
    console.error('[TTL/ERRO] Falha ao executar rotina TTL:', error.message);
  }
}

// Roda a limpeza imediatamente no startup
runTtlCleanup();

// Inicialização do Servidor HTTP
app.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================================`);
  console.log(`Servidor rodando localmente na porta: ${PORT}`);
  console.log(`Acesse no Notebook Admin: http://localhost:${PORT}/admin`);
  console.log(`Acesse no Smartphone: http://${process.env.SERVER_IP || 'IP_DO_NOTEBOOK'}:${PORT}/`);
  console.log(`================================================================`);
});