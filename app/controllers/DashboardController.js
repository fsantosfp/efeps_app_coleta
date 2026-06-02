const path = require('path');
const Pacote = require('../models/Pacote');
const AlertaFila = require('../models/AlertaFila');
const { getQueueStatus } = require('../services/QueueService');
const { getSaoPauloDate } = require('../utils/helpers');

let sseClients = [];

class DashboardController {
  /**
   * Conexão Server-Sent Events (SSE) para atualização em tempo real do frontend.
   */
  static getEvents(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.push(res);

    req.on('close', () => {
      sseClients = sseClients.filter(client => client !== res);
    });
  }

  /**
   * Transmite um evento SSE para todos os clientes conectados.
   * @param {Object} eventData Dados do evento a serem enviados.
   */
  static broadcastEvent(eventData) {
    sseClients.forEach(client => {
      client.write(`data: ${JSON.stringify(eventData)}\n\n`);
    });
  }

  /**
   * Retorna dados consolidados para o painel principal do administrador.
   */
  static getDashboard(req, res) {
    try {
      const today = getSaoPauloDate();

      // Métricas (Big Numbers) consolidados do dia corrente
      const shopeeCount = Pacote.countByPlataformaAndDate('Shopee', today);
      const mlCount = Pacote.countByPlataformaAndDate('Mercado Livre', today);

      // Fila de processamento
      const queueStatus = getQueueStatus();

      // Tabela: Últimos 50 pacotes cadastrados hoje
      const packages = Pacote.findAllByDate(today, 50);

      // Ajusta o caminho da imagem para acesso via URL
      packages.forEach(pkg => {
        pkg.caminho_imagem = `/uploads/${path.basename(pkg.caminho_imagem)}`;
      });

      // Sino de Alertas
      const alerts = AlertaFila.findAll();
      alerts.forEach(alert => {
        alert.caminho_imagem_nova = `/uploads/${path.basename(alert.caminho_imagem_nova)}`;
      });

      res.json({
        success: true,
        data: {
          date: today,
          metrics: {
            shopee: shopeeCount,
            mercadoLivre: mlCount
          },
          queue: queueStatus,
          packages,
          alerts
        }
      });
    } catch (error) {
      console.error('Erro na rota /api/dashboard:', error.message);
      res.status(500).json({ success: false, message: 'Erro ao carregar dados do dashboard.' });
    }
  }
}

module.exports = DashboardController;
