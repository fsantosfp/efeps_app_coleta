const { GoogleGenerativeAI } = require('@google/generative-ai');
const { isTransientError } = require('../utils/helpers');
require('dotenv').config();

// Inicialização do Cliente Gemini
let genAI = null;

if (process.env.GEMINI_API_KEY) {
  try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log('Google Gemini API inicializada com sucesso.');
  } catch (error) {
    console.error('Erro ao inicializar Gemini Client:', error.message);
  }
} else {
  console.warn('AVISO: GEMINI_API_KEY não configurada. Usando modo simulado para classificação.');
}

/**
 * Executa a classificação local utilizando expressões regulares como fallback resiliente.
 */
function performLocalClassification(rawText) {
  const defaultInconclusive = {
    nome_remetente: 'NÃO IDENTIFICADO',
    codigo_pacote: 'NÃO IDENTIFICADO',
    plataforma: 'NÃO IDENTIFICADO'
  };

  const upperText = rawText.toUpperCase();
  if (upperText.includes('REMETENTE')) {
    const match = rawText.match(/BR\d+/i);
    return {
      nome_remetente: 'Loja Teste S.A. (Simulado)',
      codigo_pacote: match ? match[0].toUpperCase() : 'NÃO IDENTIFICADO',
      plataforma: 'Shopee'
    };
  } else if (upperText.includes('FLEX') || upperText.includes('#')) {
    const match = rawText.match(/(?:ML-[\d-]+|Envio\s*\d+|\d{11})/i);
    return {
      nome_remetente: 'Loja Parceira #998372 (Simulado)',
      codigo_pacote: match ? match[0].toUpperCase() : 'NÃO IDENTIFICADO',
      plataforma: 'Mercado Livre'
    };
  }
  return defaultInconclusive;
}

/**
 * Envia o texto extraído para o Gemini 1.5 Flash para classificação estruturada.
 */
async function classifyText(rawText) {
  if (rawText && typeof rawText === 'string' && rawText.includes('simular_error503_gemini')) {
    const error = new Error('Google Gemini API Unavailable (503 Service Unavailable) [Simulado]');
    error.status = 503;
    throw error;
  }

  if (!genAI) {
    console.log('[SIMULADO GEMINI] Classificando texto bruto localmente:', JSON.stringify(rawText));
    return performLocalClassification(rawText);
  }

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0,
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    });

    const systemPrompt = `
Você é uma inteligência artificial especialista em processamento de documentos logísticos e etiquetas de envio.
Sua tarefa é analisar o texto extraído por OCR de uma etiqueta e extrair estruturadamente os seguintes campos em formato JSON:
- nome_remetente: String
- codigo_pacote: String (ou null se não encontrado)
- plataforma: String (valores aceitos: 'Shopee', 'Mercado Livre' ou 'NÃO IDENTIFICADO')

Regras de extração para cada campo:
1. nome_remetente: Identifique o nome do remetente na seção de REMETENTE. Se o nome estiver ilegível, rasgado ou ausente, defina como 'NÃO IDENTIFICADO'.
2. codigo_pacote: Identifique o código de rastreamento/pacote.
   - Para Shopee, o código começa estritamente com os caracteres "BR" seguido de valores numéricos (ex: BR2164448398492).
   - Para Mercado Livre, use o identificador numérico de envio (ex: 47099111704).
   Si o código estiver ausente ou ilegível, defina como 'NÃO IDENTIFICADO'. Nunca use o número do pedido (Pedido:) como código do pacote.
3. plataforma: Classifique como 'Shopee' ou 'Mercado Livre' com base nas características do texto:
   - Shopee: Deve conter o termo delimitador "REMETENTE" (ou variação clara de remetente) na seção inferior da etiqueta, layout de entrega direta ou código de rastreamento iniciando com "BR".
   - Mercado Livre: Deve conter o caractere "#" colado ao identificador numérico da loja na linha do remetente (exemplo: "Cliente Exemplo #131056") OU conter a palavra "FLEX" (referente à logística expressa do Mercado Livre).
   Se não for possível identificar a plataforma, defina como 'NÃO IDENTIFICADO'.

AVALIAÇÃO INDEPENDENTE:
Cada campo deve ser avaliado individualmente. Se um campo estiver ilegível (por exemplo, o código do pacote começar com BR estiver ausente ou rasgado), os demais campos que puderem ser identificados (como o nome do remetente ou a plataforma) devem ser extraídos normalmente. NÃO zere ou classifique os outros campos como 'NÃO IDENTIFICADO' apenas porque um deles está ausente.

Retorne APENAS um objeto JSON válido correspondente ao seguinte esquema:
{
  "nome_remetente": "Nome do remetente extraído ou 'NÃO IDENTIFICADO'",
  "codigo_pacote": "Código do pacote extraído ou 'NÃO IDENTIFICADO'",
  "plataforma": "Shopee" | "Mercado Livre" | "NÃO IDENTIFICADO"
}
`;

    const prompt = `Texto da etiqueta obtido por OCR:\n\n"""\n${rawText}\n"""`;

    const result = await model.generateContent([
      { text: systemPrompt },
      { text: prompt }
    ]);

    const responseText = result.response.text().trim();
    const data = JSON.parse(responseText);

    return {
      nome_remetente: data.nome_remetente || 'NÃO IDENTIFICADO',
      codigo_pacote: data.codigo_pacote || 'NÃO IDENTIFICADO',
      plataforma: ['Shopee', 'Mercado Livre'].includes(data.plataforma) ? data.plataforma : 'NÃO IDENTIFICADO'
    };
  } catch (error) {
    if (isTransientError(error)) {
      console.error('Erro temporário ao processar classificação com Gemini, propagando para retentativa:', error.message);
      throw error;
    }
    console.error('Erro ao processar classificação com Gemini, caindo para classificação local resiliente:', error.message);
    return performLocalClassification(rawText);
  }
}

module.exports = {
  classifyText
};
