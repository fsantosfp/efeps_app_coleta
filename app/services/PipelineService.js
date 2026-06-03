const OcrService = require('./OcrService');
const ClassificationService = require('./ClassificationService');

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

module.exports = {
  performOCR,
  classifyTextWithGemini
};
