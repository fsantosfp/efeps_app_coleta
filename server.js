require('./logger');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const { initDb, db } = require('./database');
const { enqueueImage, getQueueStatus, queueEvents } = require('./queue');
const { getSaoPauloDate, getSaoPauloTime, getSaoPauloDateTimeString, formatToBrazilDate } = require('./utils');

// =========================================================================
// SERVER-SENT EVENTS (SSE) PARA ATUALIZAÇÃO EM TEMPO REAL
// =========================================================================
let sseClients = [];

function broadcastEvent(eventData) {
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify(eventData)}\n\n`);
  });
}

// Escuta eventos da fila e notifica clientes em tempo real
queueEvents.on('process-complete', () => {
  broadcastEvent({ type: 'dashboard-update' });
});

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = process.env.UPLOADS_DIR || 'uploads';

// Inicialização do Banco de Dados
initDb();

// Garante que o diretório de uploads existe
const absoluteUploadsDir = path.isAbsolute(UPLOADS_DIR) ? UPLOADS_DIR : path.join(__dirname, UPLOADS_DIR);
if (!fs.existsSync(absoluteUploadsDir)) {
  fs.mkdirSync(absoluteUploadsDir, { recursive: true });
}

// Configuração do Multer para armazenamento de fotos das etiquetas
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, absoluteUploadsDir);
  },
  filename: (req, file, cb) => {
    // Nome único com timestamp e número aleatório
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'etiqueta-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(absoluteUploadsDir));

// Rotas de Páginas
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});


// =========================================================================
// ROTINA TTL: Exclui registros e imagens físicas com mais de 60 dias
// =========================================================================
function runTtlCleanup() {
  console.log('[TTL] Iniciando verificação de arquivos expirados (TTL 60 dias)...');
  try {
    const sixtyDaysAgo = new Date(new Date().getTime() - 60 * 24 * 60 * 60 * 1000);
    const dateLimit = getSaoPauloDate(sixtyDaysAgo);

    // 1. Limpeza de Pacotes
    const pacotesExpirados = db.prepare(`
      SELECT id, caminho_imagem FROM pacotes WHERE data_coleta < ?
    `).all(dateLimit);

    let deletedFilesCount = 0;
    pacotesExpirados.forEach(pkg => {
      if (pkg.caminho_imagem && fs.existsSync(pkg.caminho_imagem)) {
        try {
          fs.unlinkSync(pkg.caminho_imagem);
          deletedFilesCount++;
        } catch (err) {
          console.error(`[TTL] Erro ao deletar imagem de pacote ${pkg.caminho_imagem}:`, err.message);
        }
      }
    });

    const delPacotes = db.prepare(`DELETE FROM pacotes WHERE data_coleta < ?`).run(dateLimit);
    console.log(`[TTL] Limpeza de pacotes concluída. ${delPacotes.changes} registros removidos. ${deletedFilesCount} arquivos de imagem deletados.`);

    // 2. Limpeza de Alertas da Fila
    const alertasExpirados = db.prepare(`
      SELECT id, caminho_imagem_nova FROM alertas_fila WHERE data_criacao < ?
    `).all(dateLimit);

    let deletedAlertFilesCount = 0;
    alertasExpirados.forEach(alert => {
      if (alert.caminho_imagem_nova && fs.existsSync(alert.caminho_imagem_nova)) {
        try {
          fs.unlinkSync(alert.caminho_imagem_nova);
          deletedAlertFilesCount++;
        } catch (err) {
          console.error(`[TTL] Erro ao deletar imagem de alerta ${alert.caminho_imagem_nova}:`, err.message);
        }
      }
    });

    const delAlertas = db.prepare(`DELETE FROM alertas_fila WHERE data_criacao < ?`).run(dateLimit);
    console.log(`[TTL] Limpeza de alertas concluída. ${delAlertas.changes} registros removidos. ${deletedAlertFilesCount} arquivos de imagem deletados.`);

  } catch (error) {
    console.error('[TTL/ERRO] Falha ao executar rotina TTL:', error.message);
  }
}

// Roda a limpeza imediatamente no startup
runTtlCleanup();

// =========================================================================
// API ENDPOINTS
// =========================================================================

/**
 * POST /api/upload
 * Endpoint chamado pelo celular operacional para subir a foto.
 * Responde imediatamente enquanto processa em background.
 */
app.post('/api/upload', upload.single('etiqueta'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Nenhuma foto enviada.' });
  }

  const imagePath = req.file.path;
  console.log(`[HTTP] Imagem recebida e gravada: ${path.basename(imagePath)}`);

  // Envia para a fila assíncrona
  enqueueImage(imagePath);

  // Responde imediatamente ao operador de balcão móvel
  res.json({
    success: true,
    message: 'Foto enviada!',
    filename: path.basename(imagePath)
  });
});

/**
 * GET /api/events
 * Conexão Server-Sent Events (SSE) para atualização em tempo real do frontend.
 */
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

/**
 * GET /api/dashboard
 * Retorna dados em tempo real para o painel principal do administrador.
 */
app.get('/api/dashboard', (req, res) => {
  try {
    const today = getSaoPauloDate();

    // Métricas (Big Numbers) consolidados do dia corrente
    const shopeeCount = db.prepare(`
      SELECT COUNT(*) AS count FROM pacotes 
      WHERE plataforma = 'Shopee' AND data_coleta = ?
    `).get(today).count;

    const mlCount = db.prepare(`
      SELECT COUNT(*) AS count FROM pacotes 
      WHERE plataforma = 'Mercado Livre' AND data_coleta = ?
    `).get(today).count;

    // Fila de processamento
    const queueStatus = getQueueStatus();

    // Tabela: Últimos 50 pacotes cadastrados hoje
    const packages = db.prepare(`
      SELECT id, codigo_pacote, remetente_bruto, plataforma, hora_coleta, caminho_imagem 
      FROM pacotes 
      WHERE data_coleta = ?
      ORDER BY hora_coleta DESC, id DESC 
      LIMIT 50
    `).all(today);

    // Ajusta o caminho da imagem para acesso via URL
    packages.forEach(pkg => {
      pkg.caminho_imagem = `/uploads/${path.basename(pkg.caminho_imagem)}`;
    });

    // Sino de Alertas (log de falhas e duplicidade pendentes)
    const alerts = db.prepare(`
      SELECT id, tipo_erro, codigo_conflito, caminho_imagem_nova, data_criacao, remetente_sugerido, plataforma_sugerida 
      FROM alertas_fila 
      ORDER BY id DESC
    `).all();

    alerts.forEach(alert => {
      alert.caminho_imagem_nova = `/uploads/${path.basename(alert.caminho_imagem_nova)}`;
    });

    res.json({
      success: true,
      data: {
        date: today,
        metrics: {
          shopee: shopeeCount,
          mercadoLivre: mlCount
        },
        queue: queueStatus,
        packages,
        alerts
      }
    });
  } catch (error) {
    console.error('Erro na rota /api/dashboard:', error.message);
    res.status(500).json({ success: false, message: 'Erro ao carregar dados do dashboard.' });
  }
});

/**
 * PUT /api/pacotes/:id
 * Permite editar manualmente dados de um pacote já cadastrado.
 */
app.put('/api/pacotes/:id', (req, res) => {
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
      const duplicateStmt = db.prepare(`
        SELECT id FROM pacotes 
        WHERE codigo_pacote = ? AND data_coleta = ? AND id != ?
      `);
      const isDup = duplicateStmt.get(codeVal, getSaoPauloDate(), id);
      if (isDup) {
        return res.status(400).json({
          success: false,
          error: 'DUPLICIDADE',
          message: 'Este código de pacote já está cadastrado para a data de hoje.'
        });
      }
    }

    const updateStmt = db.prepare(`
      UPDATE pacotes 
      SET codigo_pacote = ?, remetente_bruto = ?, plataforma = ? 
      WHERE id = ?
    `);
    
    const result = updateStmt.run(codeVal, remetente_bruto, normalizedPlat, id);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: 'Pacote não encontrado.' });
    }

    broadcastEvent({ type: 'dashboard-update' });
    res.json({ success: true, message: 'Pacote atualizado com sucesso!' });
  } catch (error) {
    console.error(`Erro ao editar pacote ${id}:`, error.message);
    res.status(500).json({ success: false, message: 'Erro interno ao atualizar pacote.' });
  }
});

/**
 * DELETE /api/pacotes/:id
 * Remove o pacote e apaga fisicamente a imagem correspondente do disco.
 */
app.delete('/api/pacotes/:id', (req, res) => {
  const { id } = req.params;

  try {
    const pkg = db.prepare(`SELECT caminho_imagem FROM pacotes WHERE id = ?`).get(id);
    if (!pkg) {
      return res.status(404).json({ success: false, message: 'Pacote não encontrado.' });
    }

    // Exclui fisicamente a imagem correspondente do disco
    const imgPath = pkg.caminho_imagem;
    if (imgPath) {
      const absolutePath = path.isAbsolute(imgPath) ? imgPath : path.join(__dirname, imgPath);
      if (fs.existsSync(absolutePath)) {
        try {
          fs.unlinkSync(absolutePath);
        } catch (err) {
          console.error(`Erro ao deletar imagem física do pacote ${absolutePath}:`, err.message);
        }
      } else {
        const fallbackPath = path.join(absoluteUploadsDir, path.basename(imgPath));
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
    db.prepare(`DELETE FROM pacotes WHERE id = ?`).run(id);

    broadcastEvent({ type: 'dashboard-update' });
    res.json({ success: true, message: 'Pacote e imagem correspondente removidos com sucesso!' });
  } catch (error) {
    console.error(`Erro ao deletar pacote ${id}:`, error.message);
    res.status(500).json({ success: false, message: 'Erro interno ao excluir pacote.' });
  }
});

/**
 * GET /api/pacotes/:id/conflito
 * Retorna as informações do pacote original que está gerando conflito com o código do alerta.
 */
app.get('/api/pacotes/conflito/:codigo', (req, res) => {
  const { codigo } = req.params;
  try {
    const pkg = db.prepare(`
      SELECT id, codigo_pacote, remetente_bruto, plataforma, hora_coleta, caminho_imagem 
      FROM pacotes 
      WHERE codigo_pacote = ? AND data_coleta = ?
      LIMIT 1
    `).get(codigo, getSaoPauloDate());

    if (!pkg) {
      return res.status(404).json({ success: false, message: 'Nenhum pacote em conflito encontrado.' });
    }

    pkg.caminho_imagem = `/uploads/${path.basename(pkg.caminho_imagem)}`;
    res.json({ success: true, data: pkg });
  } catch (error) {
    console.error('Erro ao buscar pacote em conflito:', error.message);
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

/**
 * POST /api/alertas/:id/confirmar
 * Resolve um alerta salvando o novo pacote e excluindo a notificação do alerta.
 */
app.post('/api/alertas/:id/confirmar', (req, res) => {
  const { id } = req.params;
  const { codigo_pacote, remetente_bruto, plataforma } = req.body;

  try {
    const alert = db.prepare(`SELECT * FROM alertas_fila WHERE id = ?`).get(id);
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alerta não encontrado.' });
    }

    const codeVal = codigo_pacote && codigo_pacote.trim() !== '' ? codigo_pacote.trim() : 'NÃO IDENTIFICADO';

    // Valida duplicidade diária se for código válido
    if (codeVal !== 'NÃO IDENTIFICADO') {
      const duplicateStmt = db.prepare(`
        SELECT id FROM pacotes 
        WHERE codigo_pacote = ? AND data_coleta = ?
      `);
      const isDup = duplicateStmt.get(codeVal, getSaoPauloDate());
      if (isDup) {
        return res.status(400).json({
          success: false,
          error: 'DUPLICIDADE',
          message: 'Conflito pendente: O código do pacote ainda consta no banco de dados para hoje.'
        });
      }
    }

    // Insere o novo pacote na tabela principal
    const insertStmt = db.prepare(`
      INSERT INTO pacotes (codigo_pacote, remetente_bruto, plataforma, caminho_imagem, data_coleta, hora_coleta)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(codeVal, remetente_bruto, plataforma, alert.caminho_imagem_nova, getSaoPauloDate(), getSaoPauloTime());

    // Remove o alerta da fila
    db.prepare(`DELETE FROM alertas_fila WHERE id = ?`).run(id);

    broadcastEvent({ type: 'dashboard-update' });
    res.json({ success: true, message: 'Conflito resolvido e pacote cadastrado!' });
  } catch (error) {
    console.error(`Erro ao confirmar alerta ${id}:`, error.message);
    res.status(500).json({ success: false, message: 'Erro interno ao salvar pacote.' });
  }
});

/**
 * DELETE /api/alertas/:id
 * Remove o alerta e apaga fisicamente a imagem correspondente do disco.
 */
app.delete('/api/alertas/:id', (req, res) => {
  const { id } = req.params;

  try {
    const alert = db.prepare(`SELECT caminho_imagem_nova FROM alertas_fila WHERE id = ?`).get(id);
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alerta não encontrado.' });
    }

    // Exclui fisicamente a imagem correspondente do disco
    const imgPath = alert.caminho_imagem_nova;
    if (imgPath && fs.existsSync(imgPath)) {
      try {
        fs.unlinkSync(imgPath);
      } catch (err) {
        console.error(`Erro ao deletar imagem física do alerta ${imgPath}:`, err.message);
      }
    }

    // Deleta o registro do banco
    db.prepare(`DELETE FROM alertas_fila WHERE id = ?`).run(id);

    broadcastEvent({ type: 'dashboard-update' });
    res.json({ success: true, message: 'Alerta e imagem correspondente removidos com sucesso!' });
  } catch (error) {
    console.error(`Erro ao deletar alerta ${id}:`, error.message);
    res.status(500).json({ success: false, message: 'Erro interno ao descartar alerta.' });
  }
});

/**
 * GET /api/historico
 * Consulta retroativa de pacotes por data.
 */
app.get('/api/historico', (req, res) => {
  const { data } = req.query;
  if (!data) {
    return res.status(400).json({ success: false, message: 'A data de consulta é obrigatória.' });
  }

  try {
    const packages = db.prepare(`
      SELECT id, codigo_pacote, remetente_bruto, plataforma, hora_coleta, caminho_imagem 
      FROM pacotes 
      WHERE data_coleta = ? 
      ORDER BY hora_coleta DESC, id DESC
    `).all(data);

    packages.forEach(pkg => {
      pkg.caminho_imagem = `/uploads/${path.basename(pkg.caminho_imagem)}`;
    });

    // Pega a lista de clientes distintos nessa data para auxiliar filtros, se necessário
    res.json({ success: true, data: packages });
  } catch (error) {
    console.error(`Erro ao consultar histórico para data ${data}:`, error.message);
    res.status(500).json({ success: false, message: 'Erro interno ao consultar histórico.' });
  }
});

/**
 * GET /api/clientes
 * Lista todos os nomes brutos de remetentes cadastrados (para alimentar o checklist/autocomplete).
 */
app.get('/api/clientes', (req, res) => {
  try {
    const clients = db.prepare(`
      SELECT DISTINCT remetente_bruto FROM pacotes 
      ORDER BY remetente_bruto ASC
    `).all();
    res.json({ success: true, data: clients.map(c => c.remetente_bruto) });
  } catch (error) {
    console.error('Erro ao buscar clientes:', error.message);
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

// =========================================================================
// GERAÇÃO DE RELATÓRIOS PDF
// =========================================================================

/**
 * GET /api/relatorios/cliente
 * Emite demonstrativo para o cliente consolidando o volume enviado por suas lojas/nomes em um período.
 */
app.get('/api/relatorios/cliente', (req, res) => {
  let { clientes, dataInicio, dataFim } = req.query;

  if (!clientes || !dataInicio || !dataFim) {
    return res.status(400).send('Parâmetros "clientes", "dataInicio" e "dataFim" são obrigatórios.');
  }

  // Permite aceitar clientes separados por vírgula ou array
  let clientList = [];
  if (Array.isArray(clientes)) {
    clientList = clientes;
  } else {
    clientList = clientes.split(',').map(c => c.trim()).filter(c => c !== '');
  }

  if (clientList.length === 0) {
    return res.status(400).send('Lista de clientes vazia.');
  }

  try {
    // Monta placeholders dinâmicos para a query IN
    const placeholders = clientList.map(() => '?').join(',');
    const query = `
      SELECT data_coleta, hora_coleta, codigo_pacote, plataforma, remetente_bruto 
      FROM pacotes 
      WHERE remetente_bruto IN (${placeholders}) 
        AND data_coleta BETWEEN ? AND ?
      ORDER BY data_coleta ASC, hora_coleta ASC
    `;

    const params = [...clientList, dataInicio, dataFim];
    const rows = db.prepare(query).all(...params);

    // Cria o documento PDF
    const doc = new PDFDocument({ margin: 50 });

    // Envia direto na resposta
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=relatorio_cliente_${Date.now()}.pdf`);
    doc.pipe(res);

    // Design Header
    doc.fontSize(20).font('Helvetica-Bold').text('DEMONSTRATIVO DE PRESTAÇÃO DE CONTAS', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica-Oblique').text(`Gerado em: ${getSaoPauloDateTimeString()}`, { align: 'center' });
    doc.moveDown(1.5);

    // Informações do Filtro
    doc.fontSize(12).font('Helvetica-Bold').text('Parâmetros do Relatório:');
    doc.fontSize(10).font('Helvetica').text(`Período Solicitado: ${formatToBrazilDate(dataInicio)} a ${formatToBrazilDate(dataFim)}`);
    doc.text(`Clientes Selecionados: ${clientList.join(', ')}`);
    doc.moveDown(1.5);

    // Linha Separadora Inicial
    doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(1);

    // Helper para reimprimir cabeçalhos
    const printHeaders = (doc, y) => {
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Data/Hora', 50, y, { width: 110 });
      doc.text('Remetente Lido', 165, y, { width: 135 });
      doc.text('Plataforma', 305, y, { width: 95 });
      doc.text('Código do Pacote', 405, y, { width: 145 });
      
      doc.y = y + 15;
      doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#aaaaaa').stroke();
      doc.y += 5;
    };

    // Imprime cabeçalho inicial
    printHeaders(doc, doc.y);

    let platformTotals = { 'Shopee': 0, 'Mercado Livre': 0, 'NÃO IDENTIFICADO': 0 };

    rows.forEach(row => {
      const formattedDate = formatToBrazilDate(row.data_coleta);
      const dateText = `${formattedDate} ${row.hora_coleta}`;

      // Medição de altura para evitar quebras no meio da linha
      const h1 = doc.heightOfString(dateText, { width: 110 });
      const h2 = doc.heightOfString(row.remetente_bruto || '', { width: 135 });
      const h3 = doc.heightOfString(row.plataforma || '', { width: 95 });
      const h4 = doc.heightOfString(row.codigo_pacote || '', { width: 145 });
      const rowHeight = Math.max(h1, h2, h3, h4) + 8; // Altura máxima + espaçamento

      if (doc.y + rowHeight > 700) {
        doc.addPage();
        printHeaders(doc, 50);
      }

      const startY = doc.y;
      doc.font('Helvetica').fontSize(9);
      doc.text(dateText, 50, startY + 4, { width: 110 });
      doc.text(row.remetente_bruto || '', 165, startY + 4, { width: 135 });
      doc.text(row.plataforma || '', 305, startY + 4, { width: 95 });
      doc.text(row.codigo_pacote || '', 405, startY + 4, { width: 145 });

      doc.y = startY + rowHeight;
      
      // Linha divisória de grade sutil
      doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#eeeeee').stroke();
      doc.y += 2;

      if (platformTotals[row.plataforma] !== undefined) {
        platformTotals[row.plataforma]++;
      } else {
        platformTotals[row.plataforma] = 1;
      }
    });

    doc.moveDown(1.5);

    // Evita quebrar o resumo em página nova sozinho se estiver no limite do rodapé
    if (doc.y > 600) {
      doc.addPage();
    }

    doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(1);

    // Resumo Consolidado
    doc.fontSize(12).font('Helvetica-Bold').text('Resumo do Período:');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Shopee: ${platformTotals['Shopee']} pacotes`);
    doc.text(`Mercado Livre: ${platformTotals['Mercado Livre']} pacotes`);
    doc.text(`Não Identificados: ${platformTotals['NÃO IDENTIFICADO']} pacotes`);
    doc.fontSize(11).font('Helvetica-Bold').text(`Volume Total Consolidado: ${rows.length} pacotes`);

    doc.end();
  } catch (error) {
    console.error('Erro ao emitir relatório de cliente:', error.message);
    res.status(500).send('Erro interno ao processar PDF.');
  }
});

/**
 * GET /api/relatorios/conferencia
 * Relatório para conferência física de balcão. Filtro de data única e janela de horários.
 */
app.get('/api/relatorios/conferencia', (req, res) => {
  const { data, horaInicio, horaFim } = req.query;

  if (!data || !horaInicio || !horaFim) {
    return res.status(400).send('Parâmetros "data", "horaInicio" e "horaFim" são obrigatórios.');
  }

  try {
    // Puxa os dados da janela horária agrupando por remetente
    const query = `
      SELECT remetente_bruto, plataforma, COUNT(*) AS quantidade
      FROM pacotes
      WHERE data_coleta = ? AND hora_coleta BETWEEN ? AND ?
      GROUP BY remetente_bruto, plataforma
      ORDER BY remetente_bruto ASC
    `;

    const rows = db.prepare(query).all(data, horaInicio, horaFim);

    // Totalizadores das plataformas no intervalo
    const totalsQuery = `
      SELECT plataforma, COUNT(*) AS quantidade
      FROM pacotes
      WHERE data_coleta = ? AND hora_coleta BETWEEN ? AND ?
      GROUP BY plataforma
    `;
    const totalsRows = db.prepare(totalsQuery).all(data, horaInicio, horaFim);
    
    let platformSummary = { 'Shopee': 0, 'Mercado Livre': 0, 'NÃO IDENTIFICADO': 0 };
    let grandTotal = 0;
    
    totalsRows.forEach(row => {
      platformSummary[row.plataforma] = row.quantidade;
      grandTotal += row.quantidade;
    });

    // Cria o documento PDF
    const doc = new PDFDocument({ margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=conferencia_coleta_${data}.pdf`);
    doc.pipe(res);

    // Design Header
    doc.fontSize(18).font('Helvetica-Bold').text('RELATÓRIO DE CONFERÊNCIA DE COLETA (BALCÃO)', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica-Oblique').text(`Filtro: ${formatToBrazilDate(data)} das ${horaInicio} às ${horaFim}`, { align: 'center' });
    doc.text(`Gerado em: ${getSaoPauloDateTimeString()}`, { align: 'center' });
    doc.moveDown(1.5);

    // Linha separadora inicial
    doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#333333').stroke();
    doc.moveDown(1);

    // Lista de Clientes e quantitativos
    doc.fontSize(12).font('Helvetica-Bold').text('Volumes por Remetente e Plataforma:');
    doc.moveDown(0.5);

    // Helper para reimprimir cabeçalhos
    const printConfHeaders = (doc, y) => {
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Nome do Remetente/Loja', 50, y, { width: 250 });
      doc.text('Quantidade', 320, y, { width: 90 });
      doc.text('Plataforma', 430, y, { width: 120 });
      
      doc.y = y + 15;
      doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#aaaaaa').stroke();
      doc.y += 5;
    };

    // Imprime cabeçalho inicial
    printConfHeaders(doc, doc.y);

    rows.forEach(row => {
      // Medição de altura para evitar quebras no meio da linha
      const h1 = doc.heightOfString(row.remetente_bruto || '', { width: 250 });
      const h2 = doc.heightOfString(row.quantidade.toString(), { width: 90 });
      const h3 = doc.heightOfString(row.plataforma || '', { width: 120 });
      const rowHeight = Math.max(h1, h2, h3) + 8; // Altura máxima + espaçamento

      if (doc.y + rowHeight > 700) {
        doc.addPage();
        printConfHeaders(doc, 50);
      }

      const startY = doc.y;
      doc.font('Helvetica').fontSize(10);
      doc.text(row.remetente_bruto || '', 50, startY + 4, { width: 250 });
      doc.text(row.quantidade.toString(), 320, startY + 4, { width: 90 });
      doc.text(row.plataforma || '', 430, startY + 4, { width: 120 });
      
      doc.y = startY + rowHeight;
      
      // Linha divisória de grade sutil
      doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#eeeeee').stroke();
      doc.y += 2;
    });

    doc.end();
  } catch (error) {
    console.error('Erro ao emitir relatório de conferência:', error.message);
    res.status(500).send('Erro interno ao processar PDF.');
  }
});

// Inicialização do Servidor HTTP
app.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================================`);
  console.log(`Servidor rodando localmente na porta: ${PORT}`);
  console.log(`Acesse no Notebook Admin: http://localhost:${PORT}/admin`);
  console.log(`Acesse no Smartphone: http://${process.env.SERVER_IP || 'IP_DO_NOTEBOOK'}:${PORT}/`);
  console.log(`================================================================`);
});
