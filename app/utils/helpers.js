function getSaoPauloDate(dateObj = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dateObj);
}

function getSaoPauloTime(dateObj = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(dateObj);
}

function getSaoPauloDateTimeString(dateObj = new Date()) {
  const datePart = getSaoPauloDate(dateObj);
  const timePart = getSaoPauloTime(dateObj);
  const [year, month, day] = datePart.split('-');
  return `${day}-${month}-${year} ${timePart}`;
}

function formatToBrazilDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return dateStr;
}

function isTransientError(error) {
  if (!error) return false;
  
  // 0. Erros definitivos de cobrança/autenticação nunca são temporários (não adianta retentar):
  //    402 Payment Required (créditos pré-pagos esgotados), 401/403 (chave inválida / sem permissão)
  const rawCode = error.code || error.status || error.statusCode;
  const lowerMsg = error.message ? error.message.toLowerCase() : '';
  if ([401, 402, 403].includes(Number(rawCode)) ||
      lowerMsg.includes('402 payment required') ||
      lowerMsg.includes('prepayment credits') ||
      lowerMsg.includes('billing')) {
    return false;
  }

  // 1. Verificar propriedades de status HTTP ou gRPC
  const code = error.code || error.status || error.statusCode;
  if (code) {
    // Códigos gRPC: 14 (UNAVAILABLE), 8 (RESOURCE_EXHAUSTED), 4 (DEADLINE_EXCEEDED)
    // Códigos HTTP: 500, 502, 503, 504, 429
    if ([4, 8, 14, 429, 500, 502, 503, 504].includes(Number(code))) {
      return true;
    }
  }

  // 2. Verificar substring da mensagem de erro (fallback)
  const msg = error.message ? error.message.toLowerCase() : '';
  const transientTerms = [
    '503', '500', '502', '504', '429',
    'service unavailable', 'resource exhausted', 'rate limit',
    'quota', 'timeout', 'deadline exceeded', 'fetch failed',
    'econnreset', 'econnrefused', 'etimedout', 'enotfound', 'eai_again'
  ];

  return transientTerms.some(term => msg.includes(term));
}

/**
 * Indica se o erro deve ser tratado como falha de serviço externo (Google Vision / Gemini).
 * Inclui erros temporários (503, 429...) e erros definitivos de API marcados explicitamente
 * (ex: 402 créditos pré-pagos esgotados, 403 chave inválida/sem permissão, cota/cobrança).
 * @param {Error} error Erro capturado.
 * @returns {boolean}
 */
function isExternalServiceError(error) {
  if (!error) return false;
  return Boolean(error.isExternalServiceError) || isTransientError(error);
}

/**
 * Marca um erro como falha de serviço externo, preservando a mensagem original.
 * @param {Error} error Erro original.
 * @param {string} serviceName Nome do serviço (ex: 'Gemini', 'Vision').
 * @returns {Error} O mesmo erro, marcado.
 */
function markAsExternalServiceError(error, serviceName) {
  const err = error instanceof Error ? error : new Error(String(error));
  err.isExternalServiceError = true;
  err.serviceName = serviceName;
  return err;
}

async function retryWithBackoff(fn, retries = 3, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isTransient = isTransientError(error);
      console.warn(`[RETRY] Falha na tentativa ${attempt}/${retries} de executar chamada externa. Erro temporário? ${isTransient ? 'Sim' : 'Não'}. Mensagem: "${error.message}"`);
      
      if (attempt === retries || !isTransient) {
        throw error;
      }
      
      // Backoff exponencial com Jitter aleatório (até 1000ms extra)
      const backoff = delay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
      console.warn(`[RETRY] Aguardando ${backoff}ms antes de retentar...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
}

module.exports = {
  getSaoPauloDate,
  getSaoPauloTime,
  getSaoPauloDateTimeString,
  formatToBrazilDate,
  isTransientError,
  isExternalServiceError,
  markAsExternalServiceError,
  retryWithBackoff
};
