const fs = require('fs');
const path = require('path');
const { getSaoPauloDateTimeString } = require('./helpers');

/**
 * Log de auditoria do reprocessamento de pacotes.
 *
 * Gravado em arquivo texto dedicado (reprocessamento.log, na raiz do projeto) e também
 * espelhado no app.log via console.log. O arquivo dedicado NÃO sofre a rotação de 10MB
 * do app.log, garantindo que o histórico de "dado anterior x dado novo" fique preservado
 * para auditoria e eventual reversão manual.
 *
 * Formato de cada linha (uma linha por evento):
 * [DD-MM-AAAA HH:MM:SS] [REPROCESSAMENTO] [STATUS] execucao=<id> pacote=#<id> anterior={json} novo={json} motivo="..."
 */
const AUDIT_LOG_FILE = process.env.REPROCESS_LOG_PATH
  ? path.resolve(process.env.REPROCESS_LOG_PATH)
  : path.resolve(__dirname, '..', '..', 'reprocessamento.log');

/**
 * Extrai apenas os campos relevantes de um pacote para o log (permite reverter o registro).
 * @param {Object|null} pkg Pacote.
 * @returns {Object|null}
 */
function snapshotPackage(pkg) {
  if (!pkg) return null;
  return {
    codigo_pacote: pkg.codigo_pacote ?? null,
    remetente_bruto: pkg.remetente_bruto ?? pkg.nome_remetente ?? null,
    plataforma: pkg.plataforma ?? null
  };
}

/**
 * Registra um evento de auditoria do reprocessamento.
 * @param {Object} entry
 * @param {string} entry.status INICIO | ATUALIZADO | SEM_ALTERACAO | ERRO | RESOLVIDO_MANUALMENTE | IGNORADO
 * @param {string} [entry.runId] Identificador da execução.
 * @param {number|string} [entry.pacoteId] ID do pacote.
 * @param {Object} [entry.anterior] Dados antes do reprocessamento.
 * @param {Object} [entry.novo] Dados após o reprocessamento (ou sugeridos, em caso de erro).
 * @param {string} [entry.motivo] Descrição adicional / motivo do erro.
 * @param {Object} [entry.extra] Campos adicionais (ex: data_coleta, total, ids).
 */
function logReprocess(entry) {
  const parts = [`[${getSaoPauloDateTimeString()}]`, '[REPROCESSAMENTO]', `[${entry.status}]`];

  if (entry.runId) parts.push(`execucao=${entry.runId}`);
  if (entry.pacoteId !== undefined && entry.pacoteId !== null) parts.push(`pacote=#${entry.pacoteId}`);
  if (entry.extra) {
    Object.entries(entry.extra).forEach(([key, value]) => {
      parts.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
    });
  }
  if (entry.anterior !== undefined) parts.push(`anterior=${JSON.stringify(snapshotPackage(entry.anterior))}`);
  if (entry.novo !== undefined) parts.push(`novo=${JSON.stringify(snapshotPackage(entry.novo))}`);
  if (entry.motivo) parts.push(`motivo=${JSON.stringify(String(entry.motivo))}`);

  const line = parts.join(' ');

  try {
    fs.appendFileSync(AUDIT_LOG_FILE, line + '\n');
  } catch (err) {
    process.stderr.write(`[AUDITORIA/ERRO] Falha ao gravar log de reprocessamento: ${err.message}\n`);
  }

  // Espelha no app.log (o logger global intercepta o console)
  console.log(line);
}

module.exports = {
  logReprocess,
  snapshotPackage,
  AUDIT_LOG_FILE
};

