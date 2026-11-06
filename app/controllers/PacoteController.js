const path = require('path');
const fs = require('fs');
const Pacote = require('../models/Pacote');
const DashboardController = require('./DashboardController');
const { getSaoPauloDate } = require('../utils/helpers');
const { getUploadsDir } = require('../utils/storage');
const { enqueueReprocess } = require('../services/QueueService');
const ReprocessService = require('../services/ReprocessService');
const { logReprocess } = require('../utils/auditLog');

// Texto que o operador precisa digitar para aprovar o reprocessamento
const CONFIRMACAO_REPROCESSAMENTO = 'REPROCESSAR';
const MAX_REPROCESS_ITEMS = 2000;

class PacoteController {
  /**
   * Permite editar manualmente dados de um pacote já cadastrado.
   */
  static update(req, res) {
    const { id } = req.params;
    const { codigo_pacote, remetente_bruto, plataforma } = req.body;

    if (!remetente_bruto || !plataforma) {
      return res.status(400).json({ success: false, message: 'Remetente e Plataforma são obrigatórios.' });
    }

    try {
      const normalizedPlat = ['Shopee', 'Mercado Livre'].includes(plataforma) ? plataforma : 'NÃO IDENTIFICADO';
      const codeVal = codigo_pacote && codigo_pacote.trim() !== '' ? codigo_pacote.trim() : 'NÃO IDENTIFICADO';

      // Se o código editado não for inconclusivo, verifica se viola regra de duplicidade de hoje
      if (codeVal !== 'NÃO IDENTIFICADO') {
        const isDup = Pacote.findDuplicate(codeVal, getSaoPauloDate(), id);
        if (isDup) {
          return res.status(400).json({
            success: false,
            error: 'DUPLICIDADE',
            message: 'Este código de pacote já está cadastrado para a data de hoje.'
          });
        }
      }

      const result = Pacote.update(id, {
        codigo_pacote: codeVal,
        remetente_bruto,
        plataforma: normalizedPlat
      });

      if (result.changes === 0) {
        return res.status(404).json({ success: false, message: 'Pacote não encontrado.' });
      }

      DashboardController.broadcastEvent({ type: 'dashboard-update' });
      res.json({ success: true, message: 'Pacote atualizado com sucesso!' });
    } catch (error) {
      console.error(`Erro ao editar pacote ${id}:`, error.message);
      res.status(500).json({ success: false, message: 'Erro interno ao atualizar pacote.' });
    }
  }

  /**
   * Remove o pacote e apaga fisicamente a imagem correspondente do disco.
   */
  static delete(req, res) {
    const { id } = req.params;

    try {
      const pkg = Pacote.findById(id);
      if (!pkg) {
        return res.status(404).json({ success: false, message: 'Pacote não encontrado.' });
      }

      // Exclui fisicamente a imagem correspondente do disco
      const imgPath = pkg.caminho_imagem;
      if (imgPath) {
        // Resolve em relação ao diretório raiz
        const absolutePath = path.isAbsolute(imgPath) ? imgPath : path.resolve(__dirname, '..', '..', imgPath);
        if (fs.existsSync(absolutePath)) {
          try {
            fs.unlinkSync(absolutePath);
          } catch (err) {
            console.error(`Erro ao deletar imagem física do pacote ${absolutePath}:`, err.message);
          }
        } else {
          const fallbackPath = path.join(getUploadsDir(), path.basename(imgPath));
          if (fs.existsSync(fallbackPath)) {
            try {
              fs.unlinkSync(fallbackPath);
            } catch (err) {
              console.error(`Erro ao deletar imagem física do pacote (fallback) ${fallbackPath}:`, err.message);
            }
          }
        }
      }

      // Deleta o registro do banco
      Pacote.delete(id);

      DashboardController.broadcastEvent({ type: 'dashboard-update' });
      res.json({ success: true, message: 'Pacote e imagem correspondente removidos com sucesso!' });
    } catch (error) {
      console.error(`Erro ao deletar pacote ${id}:`, error.message);
      res.status(500).json({ success: false, message: 'Erro interno ao excluir pacote.' });
    }
  }

  /**
   * Retorna as informações do pacote original que está gerando conflito com o código do alerta.
   */
  static getConflict(req, res) {
    const { codigo } = req.params;
    try {
      const pkg = Pacote.findConflictPackage(codigo, getSaoPauloDate());

      if (!pkg) {
        return res.status(404).json({ success: false, message: 'Nenhum pacote em conflito encontrado.' });
      }

      pkg.caminho_imagem = `/uploads/${path.basename(pkg.caminho_imagem)}`;
      res.json({ success: true, data: pkg });
    } catch (error) {
      console.error('Erro ao buscar pacote em conflito:', error.message);
      res.status(500).json({ success: false, message: 'Erro interno.' });
    }
  }

  /**
   * Consulta retroativa de pacotes por data e filtro opcional de cliente.
   */
  static getHistory(req, res) {
    const { data, cliente } = req.query;
    if (!data) {
      return res.status(400).json({ success: false, message: 'A data de consulta é obrigatória.' });
    }

    try {
      const packages = Pacote.findAllByDate(data, null, cliente);

      packages.forEach(pkg => {
        pkg.caminho_imagem = `/uploads/${path.basename(pkg.caminho_imagem)}`;
      });

      res.json({ success: true, data: packages });
    } catch (error) {
      console.error(`Erro ao consultar histórico para data ${data}:`, error.message);
      res.status(500).json({ success: false, message: 'Erro interno ao consultar histórico.' });
    }
  }

  /**
   * Reprocessa (OCR + classificação novamente) um ou mais pacotes já cadastrados.
   * Exige confirmação explícita digitada pelo operador (palavra REPROCESSAR).
   * O processamento é assíncrono, na mesma fila FIFO dos novos pacotes.
   * Cada alteração é registrada no log de auditoria (reprocessamento.log) com o dado anterior e o novo.
   */
  static reprocess(req, res) {
    const { ids, confirmacao } = req.body || {};

    if (typeof confirmacao !== 'string' || confirmacao.trim() !== CONFIRMACAO_REPROCESSAMENTO) {
      return res.status(400).json({
        success: false,
        message: `Confirmação inválida. Digite exatamente "${CONFIRMACAO_REPROCESSAMENTO}" para aprovar o reprocessamento.`
      });
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'Selecione ao menos um pacote para reprocessar.' });
    }

    const uniqueIds = [...new Set(ids.map(id => Number(id)))].filter(id => Number.isInteger(id) && id > 0);
    if (uniqueIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum ID de pacote válido informado.' });
    }
    if (uniqueIds.length > MAX_REPROCESS_ITEMS) {
      return res.status(400).json({ success: false, message: `Limite de ${MAX_REPROCESS_ITEMS} pacotes por execução.` });
    }

    try {
      const found = Pacote.findByIds(uniqueIds);
      if (found.length === 0) {
        return res.status(404).json({ success: false, message: 'Nenhum dos pacotes selecionados foi encontrado.' });
      }

      const foundIds = found.map(p => p.id);
      const notFound = uniqueIds.filter(id => !foundIds.includes(id));
      const runId = ReprocessService.generateRunId();

      logReprocess({
        status: 'INICIO',
        runId,
        extra: { total: foundIds.length, ids: foundIds, nao_encontrados: notFound }
      });

      enqueueReprocess(foundIds, runId);
      DashboardController.broadcastEvent({ type: 'dashboard-update' });

      res.json({
        success: true,
        message: `${foundIds.length} pacote(s) enviado(s) para reprocessamento (execução ${runId}).`,
        data: { runId, total: foundIds.length, notFound }
      });
    } catch (error) {
      console.error('Erro ao iniciar reprocessamento de pacotes:', error.message);
      res.status(500).json({ success: false, message: 'Erro interno ao iniciar o reprocessamento.' });
    }
  }

  /**
   * Lista todos os nomes brutos de remetentes cadastrados para autocomplete.
   */
  static getClients(req, res) {
    try {
      const clients = Pacote.findDistinctClients();
      res.json({ success: true, data: clients });
    } catch (error) {
      console.error('Erro ao buscar clientes:', error.message);
      res.status(500).json({ success: false, message: 'Erro interno.' });
    }
  }
}

module.exports = PacoteController;
