const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'app.log');

// Rotatividade de Logs: se o arquivo passar de 10MB, renomeia para backup e inicia um novo
if (fs.existsSync(logFile)) {
  try {
    const stats = fs.statSync(logFile);
    if (stats.size > 10 * 1024 * 1024) { // 10MB
      const backupFile = path.join(__dirname, 'app.old.log');
      if (fs.existsSync(backupFile)) {
        fs.unlinkSync(backupFile);
      }
      fs.renameSync(logFile, backupFile);
    }
  } catch (err) {
    process.stderr.write(`[LOGGER/ROTAÇÃO] Erro ao rotacionar log: ${err.message}\n`);
  }
}

// Emula fuso horário de São Paulo (UTC-3)
function getSaoPauloTimestamp() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date());
}

function writeLog(level, message) {
  const timestamp = getSaoPauloTimestamp();
  const formattedMsg = `[${timestamp}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, formattedMsg);
  } catch (err) {
    process.stderr.write(`[LOGGER/ERRO] Falha ao gravar no arquivo de log: ${err.message}\n`);
  }
}

// Salva as referências originais do console
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
  originalLog(...args);
  writeLog('INFO', msg);
};

console.error = (...args) => {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
  originalError(...args);
  writeLog('ERROR', msg);
};

console.warn = (...args) => {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
  originalWarn(...args);
  writeLog('WARN', msg);
};

console.log(`[LOGGER] Sistema de gravação de logs iniciado em: ${logFile}`);
