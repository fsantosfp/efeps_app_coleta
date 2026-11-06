const OcrService = require('./OcrService');
const ClassificationService = require('./ClassificationService');
const { retryWithBackoff } = require('../utils/helpers');

/**
 * Executa OCR na imagem informada delegando ao OcrService.
 * @param {string} imagePath Caminho completo da imagem no disco.
 * @returns {Promise<string>} Texto extraído da imagem.
 */
async function performOCR(imagePath) {
  return OcrService.extractText(imagePath);
}

/**
 * Envia o texto extraído para classificação delegando ao ClassificationService.
 * @param {string} rawText Texto bruto extraído da etiqueta.
 * @returns {Promise<Object>} Dados classificados (nome_remetente, codigo_pacote, plataforma).
 */
async function classifyTextWithGemini(rawText) {
  return ClassificationService.classifyText(rawText);
}

/**
 * Executa o pipeline completo (OCR + classificação) com retentativas espaçadas.
 * Usado tanto pela fila de novos pacotes quanto pelo reprocessamento de pacotes existentes.
 * @param {string} imagePath Caminho completo da imagem no disco.
 * @returns {Promise<Object>} Dados classificados (nome_remetente, codigo_pacote, plataforma).
 */
async function analyzeImage(imagePath) {
  const ocrText = await retryWithBackoff(() => performOCR(imagePath), 3, 2000);
  return retryWithBackoff(() => classifyTextWithGemini(ocrText), 3, 2000);
}

/**
 * Indica se o resultado da classificação está incompleto (algum campo não identificado).
 * @param {Object} metadata Resultado da classificação.
 * @returns {boolean}
 */
function hasMissingData(metadata) {
  if (!metadata) return true;
  return ['codigo_pacote', 'nome_remetente', 'plataforma'].some(field => {
    const value = metadata[field];
    return !value || String(value).trim() === '' || value === 'NÃO IDENTIFICADO';
  });
}

module.exports = {
  performOCR,
  classifyTextWithGemini,
  analyzeImage,
  hasMissingData
};
