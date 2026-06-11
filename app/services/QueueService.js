const path = require('path');
const EventEmitter = require('events');
const Pacote = require('../models/Pacote');
const AlertaFila = require('../models/AlertaFila');
const { performOCR, classifyTextWithGemini } = require('./PipelineService');
const { getSaoPauloDate, getSaoPauloTime, isTransientError, retryWithBackoff } = require('../utils/helpers');

const queueEvents = new EventEmitter();

// Fila em memória
const fileQueue = [];
let activeWorkers = 0;
const MAX_CONCURRENT_WORKERS = 1; // Limite rigoroso de 1 por vez para economizar CPU/RAM no i5

// Estatísticas para a Dashboard
let totalEnqueuedToday = 0;
let totalProcessedToday = 0;

/**
 * Adiciona um arquivo de imagem à fila de processamento.
 * @param {string} imagePath Caminho completo da imagem no disco.
 */
function enqueueImage(imagePath) {
  fileQueue.push(imagePath);
  totalEnqueuedToday++;
  console.log(`[FILA] Item adicionado. Fila atual: ${fileQueue.length} pendentes.`);

  // Dispara o processamento se houver capacidade
  if (activeWorkers < MAX_CONCURRENT_WORKERS) {
    processNext();
  }
}

/**
 * Obtém o status atual do monitoramento da fila.
 */
function getQueueStatus() {
  return {
    pending: fileQueue.length,
    processing: activeWorkers,
    totalToday: totalEnqueuedToday,
    processedToday: totalProcessedToday
  };
}

/**
 * Processador recursivo da fila FIFO.
 */
async function processNext() {
  if (fileQueue.length === 0) {
    activeWorkers = 0;
    return;
  }

  activeWorkers++;
  const currentImagePath = fileQueue.shift();
  const filename = path.basename(currentImagePath);
  console.log(`[FILA] Iniciando processamento do arquivo: ${filename}`);

  try {
    // 1. OCR (Vision API) com retentativa espaçada
    console.log(`[FILA] OCR para ${filename}`);
    const ocrText = await retryWithBackoff(() => performOCR(currentImagePath), 3, 2000);

    // 2. Classificação Semântica (Gemini 1.5 Flash) com retentativa espaçada
    console.log(`[FILA] Classificacao para ${filename}`);
    const metadata = await retryWithBackoff(() => classifyTextWithGemini(ocrText), 3, 2000);
    console.log(`[FILA] Resultado da classificação para ${filename}:`, JSON.stringify(metadata));

    // 3. Validações e Persistência no Banco de Dados
    const today = getSaoPauloDate();

    const hasMissingData =
      !metadata.codigo_pacote || metadata.codigo_pacote.trim() === '' || metadata.codigo_pacote === 'NÃO IDENTIFICADO' ||
      !metadata.nome_remetente || metadata.nome_remetente.trim() === '' || metadata.nome_remetente === 'NÃO IDENTIFICADO' ||
      !metadata.plataforma || metadata.plataforma.trim() === '' || metadata.plataforma === 'NÃO IDENTIFICADO';

    if (hasMissingData) {
      // Inconclusivo: Grava na tabela de alertas de fila para revisão do operador
      AlertaFila.create({
        tipo_erro: 'LEITURA_INCOMPLETA',
        codigo_conflito: metadata.codigo_pacote,
        caminho_imagem_nova: currentImagePath,
        data_criacao: today,
        remetente_sugerido: metadata.nome_remetente,
        plataforma_sugerida: metadata.plataforma
      });
      console.log(`[BANCO/ALERTA] Identificação incompleta detectada para pacote. Alerta 'LEITURA_INCOMPLETA' criado.`);
    } else {
      // Identificado com sucesso: verificar duplicidade na data atual (hoje)
      const existing = Pacote.findDuplicate(metadata.codigo_pacote, today);

      if (existing) {
        // Conflito de Duplicidade: Grava na tabela de alertas de fila
        AlertaFila.create({
          tipo_erro: 'DUPLICIDADE',
          codigo_conflito: metadata.codigo_pacote,
          caminho_imagem_nova: currentImagePath,
          data_criacao: today,
          remetente_sugerido: metadata.nome_remetente,
          plataforma_sugerida: metadata.plataforma
        });
        console.log(`[BANCO/ALERTA] Duplicidade detectada para código ${metadata.codigo_pacote}. Alerta 'DUPLICIDADE' criado.`);
      } else {
        // Sem conflito: Grava na tabela principal de pacotes
        Pacote.create({
          codigo_pacote: metadata.codigo_pacote,
          remetente_bruto: metadata.nome_remetente,
          plataforma: metadata.plataforma,
          caminho_imagem: currentImagePath,
          data_coleta: today,
          hora_coleta: getSaoPauloTime()
        });
        console.log(`[BANCO] Pacote gravado com sucesso: ${metadata.codigo_pacote}`);
      }
    }
  } catch (error) {
    console.error(`[FILA/ERRO] Falha crítica ao processar ${filename}:`, error.message);

    // Se o erro for de conexão/API temporária (exauriu as retentativas do 503), salvamos como erro de serviço externo na DLQ
    try {
      if (isTransientError(error)) {
        AlertaFila.create({
          tipo_erro: 'ERRO_SERVICO_EXTERNO',
          codigo_conflito: error.message || 'Erro temporário nas APIs externas',
          caminho_imagem_nova: currentImagePath,
          data_criacao: getSaoPauloDate(),
          remetente_sugerido: 'NÃO IDENTIFICADO',
          plataforma_sugerida: 'NÃO IDENTIFICADO'
        });
        console.log(`[BANCO/ALERTA] Falha de serviço externo salva na DLQ (ERRO_SERVICO_EXTERNO) para ${filename}.`);
      } else {
        // Falha não temporária (ex: formato incorreto, falha total de processamento local)
        AlertaFila.create({
          tipo_erro: 'LEITURA_INCOMPLETA',
          codigo_conflito: 'ERRO_PIPELINE',
          caminho_imagem_nova: currentImagePath,
          data_criacao: getSaoPauloDate(),
          remetente_sugerido: 'NÃO IDENTIFICADO',
          plataforma_sugerida: 'NÃO IDENTIFICADO'
        });
        console.log(`[BANCO/ALERTA] Falha crítica não temporária gravada como LEITURA_INCOMPLETA.`);
      }
    } catch (dbErr) {
      console.error('[FILA/ERRO] Falha ao registrar alerta no banco de dados:', dbErr.message);
    }
  } finally {
    totalProcessedToday++;
    activeWorkers--;
    queueEvents.emit('process-complete');
    // Próximo da fila
    processNext();
  }
}

/**
 * Reinicia os contadores diários (usado em novas inicializações de dias)
 */
function resetQueueCounters() {
  totalEnqueuedToday = 0;
  totalProcessedToday = 0;
}

module.exports = {
  enqueueImage,
  getQueueStatus,
  resetQueueCounters,
  queueEvents
};
