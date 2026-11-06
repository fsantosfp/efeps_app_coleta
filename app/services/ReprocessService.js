const fs = require('fs');
const path = require('path');
const Pacote = require('../models/Pacote');
const AlertaFila = require('../models/AlertaFila');
const PipelineService = require('./PipelineService');
const { getUploadsDir } = require('../utils/storage');
const { logReprocess } = require('../utils/auditLog');

const TIPO_ALERTA_REPROCESSAMENTO = 'REPROCESSAMENTO_ERRO';
const NAO_IDENTIFICADO = 'NÃO IDENTIFICADO';

/**
 * Gera um identificador legível para uma execução de reprocessamento (ex: RP-20261106-125000-123).
 * @returns {string}
 */
function generateRunId() {
  const now = new Date();
  const stamp = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const suffix = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `RP-${stamp.year}${stamp.month}${stamp.day}-${stamp.hour}${stamp.minute}${stamp.second}-${suffix}`;
}

/**
 * Resolve o caminho físico da imagem do pacote (absoluto, relativo à raiz ou na pasta de uploads).
 * @param {string} imgPath Caminho gravado no banco.
 * @returns {string|null} Caminho existente no disco ou null.
 */
function resolveImagePath(imgPath) {
  if (!imgPath) return null;
  const absolutePath = path.isAbsolute(imgPath) ? imgPath : path.resolve(__dirname, '..', '..', imgPath);
  if (fs.existsSync(absolutePath)) return absolutePath;
  const fallbackPath = path.join(getUploadsDir(), path.basename(imgPath));
  if (fs.existsSync(fallbackPath)) return fallbackPath;
  return null;
}

/**
 * Normaliza o resultado da classificação para o formato da tabela de pacotes.
 * @param {Object} metadata Resultado do pipeline.
 * @returns {Object}
 */
function toPackageData(metadata) {
  return {
    codigo_pacote: metadata && metadata.codigo_pacote ? String(metadata.codigo_pacote).trim() : NAO_IDENTIFICADO,
    remetente_bruto: metadata && metadata.nome_remetente ? String(metadata.nome_remetente).trim() : NAO_IDENTIFICADO,
    plataforma: metadata && metadata.plataforma ? metadata.plataforma : NAO_IDENTIFICADO
  };
}

/**
 * Mantém o pacote inalterado e registra a falha na fila de alertas, permitindo que o
 * operador retente o reprocessamento ou resolva manualmente a partir da tela de Alertas.
 */
function registerFailure(pkg, runId, motivo, suggested = null) {
  // Evita alertas duplicados para o mesmo pacote
  AlertaFila.deleteByPacoteId(pkg.id, TIPO_ALERTA_REPROCESSAMENTO);

  AlertaFila.create({
    tipo_erro: TIPO_ALERTA_REPROCESSAMENTO,
    codigo_conflito: suggested ? suggested.codigo_pacote : NAO_IDENTIFICADO,
    caminho_imagem_nova: pkg.caminho_imagem,
    data_criacao: pkg.data_coleta,
    hora_criacao: pkg.hora_coleta,
    remetente_sugerido: suggested ? suggested.remetente_bruto : NAO_IDENTIFICADO,
    plataforma_sugerida: suggested ? suggested.plataforma : NAO_IDENTIFICADO,
    pacote_id: pkg.id,
    detalhe: motivo
  });

  logReprocess({
    status: 'ERRO',
    runId,
    pacoteId: pkg.id,
    extra: { data_coleta: pkg.data_coleta, hora_coleta: pkg.hora_coleta },
    anterior: pkg,
    novo: suggested,
    motivo: `${motivo} (registro mantido inalterado; alerta ${TIPO_ALERTA_REPROCESSAMENTO} criado)`
  });

  return { status: 'ERRO', motivo };
}

/**
 * Reprocessa um único pacote existente: executa OCR + classificação novamente na imagem
 * original e atualiza o registro. Em caso de resultado problemático, o registro é mantido
 * inalterado e um alerta REPROCESSAMENTO_ERRO é criado.
 * @param {number|string} pacoteId ID do pacote.
 * @param {string} runId Identificador da execução (auditoria).
 * @returns {Promise<Object>} { status, motivo? }
 */
async function reprocessPackage(pacoteId, runId) {
  const pkg = Pacote.findById(pacoteId);
  if (!pkg) {
    logReprocess({ status: 'IGNORADO', runId, pacoteId, motivo: 'Pacote não encontrado (pode ter sido excluído).' });
    return { status: 'IGNORADO', motivo: 'Pacote não encontrado.' };
  }

  const imagePath = resolveImagePath(pkg.caminho_imagem);
  if (!imagePath) {
    return registerFailure(pkg, runId, 'Imagem da etiqueta não encontrada no disco.');
  }

  let suggested;
  try {
    const metadata = await PipelineService.analyzeImage(imagePath);
    suggested = toPackageData(metadata);

    if (PipelineService.hasMissingData(metadata)) {
      return registerFailure(pkg, runId, 'Leitura incompleta: um ou mais campos não foram identificados.', suggested);
    }
  } catch (error) {
    const prefix = error && error.serviceName ? `Falha no serviço externo (${error.serviceName})` : 'Falha no processamento';
    return registerFailure(pkg, runId, `${prefix}: ${error && error.message ? error.message : error}`);
  }

  // Regra de unicidade: mesmo código não pode existir em outro pacote da mesma data de coleta
  const duplicate = Pacote.findDuplicate(suggested.codigo_pacote, pkg.data_coleta, pkg.id);
  if (duplicate) {
    return registerFailure(
      pkg, runId,
      `Código ${suggested.codigo_pacote} já pertence ao pacote #${duplicate.id} na data ${pkg.data_coleta}.`,
      suggested
    );
  }

  const unchanged =
    pkg.codigo_pacote === suggested.codigo_pacote &&
    pkg.remetente_bruto === suggested.remetente_bruto &&
    pkg.plataforma === suggested.plataforma;

  if (unchanged) {
    AlertaFila.deleteByPacoteId(pkg.id, TIPO_ALERTA_REPROCESSAMENTO);
    logReprocess({
      status: 'SEM_ALTERACAO', runId, pacoteId: pkg.id,
      extra: { data_coleta: pkg.data_coleta, hora_coleta: pkg.hora_coleta },
      anterior: pkg, novo: suggested
    });
    return { status: 'SEM_ALTERACAO' };
  }

  try {
    Pacote.update(pkg.id, suggested);
  } catch (error) {
    // Ex: violação do índice único em condição de corrida
    return registerFailure(pkg, runId, `Falha ao gravar no banco: ${error.message}`, suggested);
  }

  AlertaFila.deleteByPacoteId(pkg.id, TIPO_ALERTA_REPROCESSAMENTO);
  logReprocess({
    status: 'ATUALIZADO', runId, pacoteId: pkg.id,
    extra: { data_coleta: pkg.data_coleta, hora_coleta: pkg.hora_coleta },
    anterior: pkg, novo: suggested
  });
  return { status: 'ATUALIZADO' };
}

module.exports = {
  TIPO_ALERTA_REPROCESSAMENTO,
  generateRunId,
  resolveImagePath,
  reprocessPackage
};
