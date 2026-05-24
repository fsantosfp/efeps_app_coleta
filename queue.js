const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { db } = require('./database');
const { performOCR, classifyTextWithGemini } = require('./pipeline');
const { getSaoPauloDate, getSaoPauloTime } = require('./utils');

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
    // 1. OCR (Vision API)
    const ocrText = await performOCR(currentImagePath);
    
    // 2. Classificação Semântica (Gemini 1.5 Flash)
    const metadata = await classifyTextWithGemini(ocrText);
    console.log(`[FILA] Resultado da classificação para ${filename}:`, JSON.stringify(metadata));

    // 3. Validações e Persistência no Banco de Dados
    const today = getSaoPauloDate();

    const hasMissingData = 
      !metadata.codigo_pacote || metadata.codigo_pacote.trim() === '' || metadata.codigo_pacote === 'NÃO IDENTIFICADO' ||
      !metadata.nome_remetente || metadata.nome_remetente.trim() === '' || metadata.nome_remetente === 'NÃO IDENTIFICADO' ||
      !metadata.plataforma || metadata.plataforma.trim() === '' || metadata.plataforma === 'NÃO IDENTIFICADO';

    if (hasMissingData) {
      // Inconclusivo: Grava na tabela de alertas de fila para revisão do operador
      const alertStmt = db.prepare(`
        INSERT INTO alertas_fila (tipo_erro, codigo_conflito, caminho_imagem_nova, data_criacao, remetente_sugerido, plataforma_sugerida)
        VALUES ('LEITURA_INCOMPLETA', ?, ?, ?, ?, ?)
      `);
      alertStmt.run(metadata.codigo_pacote, currentImagePath, today, metadata.nome_remetente, metadata.plataforma);
      console.log(`[BANCO/ALERTA] Identificação incompleta detectada para pacote. Alerta 'LEITURA_INCOMPLETA' criado.`);
    } else {
      // Identificado com sucesso: verificar duplicidade na data atual (hoje)
      const checkStmt = db.prepare(`
        SELECT id, remetente_bruto, plataforma, caminho_imagem, hora_coleta 
        FROM pacotes 
        WHERE codigo_pacote = ? AND data_coleta = ?
      `);
      const existing = checkStmt.get(metadata.codigo_pacote, today);

      if (existing) {
        // Conflito de Duplicidade: Grava na tabela de alertas de fila
        const alertStmt = db.prepare(`
          INSERT INTO alertas_fila (tipo_erro, codigo_conflito, caminho_imagem_nova, data_criacao, remetente_sugerido, plataforma_sugerida)
          VALUES ('DUPLICIDADE', ?, ?, ?, ?, ?)
        `);
        alertStmt.run(metadata.codigo_pacote, currentImagePath, today, metadata.nome_remetente, metadata.plataforma);
        console.log(`[BANCO/ALERTA] Duplicidade detectada para código ${metadata.codigo_pacote}. Alerta 'DUPLICIDADE' criado.`);
      } else {
        // Sem conflito: Grava na tabela principal de pacotes
        const stmt = db.prepare(`
          INSERT INTO pacotes (codigo_pacote, remetente_bruto, plataforma, caminho_imagem, data_coleta, hora_coleta)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(metadata.codigo_pacote, metadata.nome_remetente, metadata.plataforma, currentImagePath, today, getSaoPauloTime());
        console.log(`[BANCO] Pacote gravado com sucesso: ${metadata.codigo_pacote}`);
      }
    }
  } catch (error) {
    console.error(`[FILA/ERRO] Falha crítica ao processar ${filename}:`, error.message);
    
    // Tratamento de falha total do pipeline (salva como falha incompleta para revisão posterior)
    try {
      const stmt = db.prepare(`
        INSERT INTO alertas_fila (tipo_erro, codigo_conflito, caminho_imagem_nova, data_criacao, remetente_sugerido, plataforma_sugerida)
        VALUES ('LEITURA_INCOMPLETA', 'ERRO_PIPELINE', ?, ?, ?, ?)
      `);
      stmt.run(currentImagePath, getSaoPauloDate(), 'NÃO IDENTIFICADO', 'NÃO IDENTIFICADO');
    } catch (dbErr) {
      console.error('[FILA/ERRO] Falha ao registrar alerta de falha de leitura no banco:', dbErr.message);
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
