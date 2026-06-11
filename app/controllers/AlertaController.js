const path = require('path');
const fs = require('fs');
const AlertaFila = require('../models/AlertaFila');
const Pacote = require('../models/Pacote');
const DashboardController = require('./DashboardController');
const { enqueueImage } = require('../services/QueueService');
const { getSaoPauloDate, getSaoPauloTime } = require('../utils/helpers');

class AlertaController {
  /**
   * Resolve um alerta salvando o novo pacote e excluindo a notificação do alerta.
   */
  static confirm(req, res) {
    const { id } = req.params;
    const { codigo_pacote, remetente_bruto, plataforma } = req.body;

    try {
      const alert = AlertaFila.findById(id);
      if (!alert) {
        return res.status(404).json({ success: false, message: 'Alerta não encontrado.' });
      }

      const codeVal = codigo_pacote && codigo_pacote.trim() !== '' ? codigo_pacote.trim() : 'NÃO IDENTIFICADO';

      // Valida duplicidade diária se for código válido
      if (codeVal !== 'NÃO IDENTIFICADO') {
        const isDup = Pacote.findDuplicate(codeVal, getSaoPauloDate());
        if (isDup) {
          return res.status(400).json({
            success: false,
            error: 'DUPLICIDADE',
            message: 'Conflito pendente: O código do pacote ainda consta no banco de dados para hoje.'
          });
        }
      }

      // Insere o novo pacote na tabela principal
      Pacote.create({
        codigo_pacote: codeVal,
        remetente_bruto,
        plataforma,
        caminho_imagem: alert.caminho_imagem_nova,
        data_coleta: getSaoPauloDate(),
        hora_coleta: getSaoPauloTime()
      });

      // Remove o alerta da fila
      AlertaFila.delete(id);

      DashboardController.broadcastEvent({ type: 'dashboard-update' });
      res.json({ success: true, message: 'Conflito resolvido e pacote cadastrado!' });
    } catch (error) {
      console.error(`Erro ao confirmar alerta ${id}:`, error.message);
      res.status(500).json({ success: false, message: 'Erro interno ao salvar pacote.' });
    }
  }

  /**
   * Remove o alerta e apaga fisicamente a imagem correspondente do disco.
   */
  static delete(req, res) {
    const { id } = req.params;

    try {
      const alert = AlertaFila.findById(id);
      if (!alert) {
        return res.status(404).json({ success: false, message: 'Alerta não encontrado.' });
      }

      // Exclui fisicamente a imagem correspondente do disco
      const imgPath = alert.caminho_imagem_nova;
      if (imgPath) {
        const absolutePath = path.isAbsolute(imgPath) ? imgPath : path.resolve(__dirname, '..', '..', imgPath);
        if (fs.existsSync(absolutePath)) {
          try {
            fs.unlinkSync(absolutePath);
          } catch (err) {
            console.error(`Erro ao deletar imagem física do alerta ${imgPath}:`, err.message);
          }
        }
      }

      // Deleta o registro do banco
      AlertaFila.delete(id);

      DashboardController.broadcastEvent({ type: 'dashboard-update' });
      res.json({ success: true, message: 'Alerta e imagem correspondente removidos com sucesso!' });
    } catch (error) {
      console.error(`Erro ao deletar alerta ${id}:`, error.message);
      res.status(500).json({ success: false, message: 'Erro interno ao descartar alerta.' });
    }
  }

  /**
   * Reprocessa um alerta da DLQ, enfileirando novamente a imagem física associada.
   */
  static retry(req, res) {
    const { id } = req.params;

    try {
      const alert = AlertaFila.findById(id);
      if (!alert) {
        return res.status(404).json({ success: false, message: 'Alerta não encontrado.' });
      }

      console.log(`[HTTP] Retentando processamento do alerta #${id}: ${alert.caminho_imagem_nova}`);

      // Envia novamente para a fila de processamento assíncrono
      enqueueImage(alert.caminho_imagem_nova);

      // Remove o alerta da DLQ para não ficar pendente enquanto reprocessa
      AlertaFila.delete(id);

      // Atualiza o painel
      DashboardController.broadcastEvent({ type: 'dashboard-update' });

      res.json({
        success: true,
        message: 'Processamento reiniciado na fila em background.'
      });
    } catch (error) {
      console.error(`Erro ao retentar processamento do alerta ${id}:`, error.message);
      res.status(500).json({ success: false, message: 'Erro interno ao tentar reprocessar.' });
    }
  }
}

module.exports = AlertaController;
