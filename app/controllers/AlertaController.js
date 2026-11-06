const path = require('path');
const fs = require('fs');
const AlertaFila = require('../models/AlertaFila');
const Pacote = require('../models/Pacote');
const DashboardController = require('./DashboardController');
const { enqueueImage, enqueueReprocess } = require('../services/QueueService');
const ReprocessService = require('../services/ReprocessService');
const { logReprocess } = require('../utils/auditLog');
const { getSaoPauloDate, getSaoPauloTime } = require('../utils/helpers');
const { getUploadsDir } = require('../utils/storage');

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

      // Alerta de reprocessamento: atualiza o pacote existente em vez de criar um novo
      if (alert.pacote_id) {
        return AlertaController.confirmReprocessAlert(alert, req, res);
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
   * Resolve manualmente um alerta REPROCESSAMENTO_ERRO, gravando os dados informados no
   * pacote já existente (mantendo data/hora de coleta) e registrando a auditoria.
   */
  static confirmReprocessAlert(alert, req, res) {
    const { codigo_pacote, remetente_bruto, plataforma } = req.body;

    const pkg = Pacote.findById(alert.pacote_id);
    if (!pkg) {
      AlertaFila.delete(alert.id);
      DashboardController.broadcastEvent({ type: 'dashboard-update' });
      return res.status(404).json({ success: false, message: 'O pacote original não existe mais. O alerta foi removido.' });
    }

    if (!remetente_bruto || !remetente_bruto.trim()) {
      return res.status(400).json({ success: false, message: 'O nome do remetente é obrigatório.' });
    }

    const newData = {
      codigo_pacote: codigo_pacote && codigo_pacote.trim() !== '' ? codigo_pacote.trim() : 'NÃO IDENTIFICADO',
      remetente_bruto: remetente_bruto.trim(),
      plataforma: ['Shopee', 'Mercado Livre'].includes(plataforma) ? plataforma : 'NÃO IDENTIFICADO'
    };

    if (newData.codigo_pacote !== 'NÃO IDENTIFICADO') {
      const dup = Pacote.findDuplicate(newData.codigo_pacote, pkg.data_coleta, pkg.id);
      if (dup) {
        return res.status(400).json({
          success: false,
          error: 'DUPLICIDADE',
          message: `O código ${newData.codigo_pacote} já pertence ao pacote #${dup.id} na data ${pkg.data_coleta}.`
        });
      }
    }

    Pacote.update(pkg.id, newData);
    AlertaFila.delete(alert.id);

    logReprocess({
      status: 'RESOLVIDO_MANUALMENTE',
      pacoteId: pkg.id,
      extra: { alerta: alert.id, data_coleta: pkg.data_coleta, hora_coleta: pkg.hora_coleta },
      anterior: pkg,
      novo: newData
    });

    DashboardController.broadcastEvent({ type: 'dashboard-update' });
    return res.json({ success: true, message: 'Pacote existente atualizado com sucesso!' });
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

      // Alerta de reprocessamento: a imagem pertence a um pacote existente e NÃO pode ser apagada.
      // Descartar apenas remove o alerta, mantendo o registro do pacote como está.
      if (alert.pacote_id) {
        AlertaFila.delete(id);
        logReprocess({
          status: 'ALERTA_DESCARTADO',
          pacoteId: alert.pacote_id,
          extra: { alerta: alert.id },
          motivo: 'Operador optou por manter o registro atual do pacote.'
        });
        DashboardController.broadcastEvent({ type: 'dashboard-update' });
        return res.json({ success: true, message: 'Alerta descartado. O pacote foi mantido sem alterações.' });
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
        } else {
          const fallbackPath = path.join(getUploadsDir(), path.basename(imgPath));
          if (fs.existsSync(fallbackPath)) {
            try {
              fs.unlinkSync(fallbackPath);
            } catch (err) {
              console.error(`Erro ao deletar imagem física do alerta (fallback) ${fallbackPath}:`, err.message);
            }
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
   * Preserva a data e hora originais da coleta para garantir que o registro
   * seja salvo com a data em que a foto foi tirada, não do momento do retry.
   */
  static retry(req, res) {
    const { id } = req.params;

    try {
      const alert = AlertaFila.findById(id);
      if (!alert) {
        return res.status(404).json({ success: false, message: 'Alerta não encontrado.' });
      }

      console.log(`[HTTP] Retentando processamento do alerta #${id}: ${alert.caminho_imagem_nova} (data original: ${alert.data_criacao} ${alert.hora_criacao || 'N/A'})`);

      AlertaController.requeueAlert(alert);

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

  /**
   * Reenvia um alerta para a fila e o remove da DLQ.
   * - Alertas de reprocessamento (vinculados a um pacote): reprocessam o pacote existente.
   * - Demais alertas: reenfileiram a imagem preservando data/hora originais da coleta.
   * @param {Object} alert Alerta da DLQ.
   */
  static requeueAlert(alert) {
    if (alert.pacote_id) {
      const runId = `${ReprocessService.generateRunId()}-ALERTA${alert.id}`;
      logReprocess({ status: 'INICIO', runId, extra: { origem: `alerta #${alert.id}`, total: 1, ids: [alert.pacote_id] } });
      enqueueReprocess([alert.pacote_id], runId);
    } else {
      enqueueImage(alert.caminho_imagem_nova, alert.data_criacao, alert.hora_criacao || null);
    }
    AlertaFila.delete(alert.id);
  }

  /**
   * Reprocessa todos os alertas da DLQ de uma vez.
   * Cada alerta é reenfileirado com sua data e hora originais de coleta.
   */
  static retryAll(req, res) {
    try {
      const alerts = AlertaFila.findAll();

      if (alerts.length === 0) {
        return res.json({ success: true, message: 'Nenhum alerta pendente para reprocessar.', total: 0 });
      }

      console.log(`[HTTP] Retry All: reenfileirando ${alerts.length} alerta(s) da DLQ.`);

      for (const alert of alerts) {
        console.log(`[HTTP] Retry All → alerta #${alert.id}: ${alert.caminho_imagem_nova} (data original: ${alert.data_criacao} ${alert.hora_criacao || 'N/A'})`);
        AlertaController.requeueAlert(alert);
      }

      // Atualiza o painel uma única vez após enfileirar todos
      DashboardController.broadcastEvent({ type: 'dashboard-update' });

      res.json({
        success: true,
        message: `${alerts.length} alerta(s) reenfileirado(s) para reprocessamento.`,
        total: alerts.length
      });
    } catch (error) {
      console.error('Erro ao executar retry de todos os alertas:', error.message);
      res.status(500).json({ success: false, message: 'Erro interno ao tentar reprocessar todos os alertas.' });
    }
  }
}

module.exports = AlertaController;
