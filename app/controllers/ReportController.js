const PDFDocument = require('pdfkit');
const Pacote = require('../models/Pacote');
const { getSaoPauloDateTimeString, formatToBrazilDate } = require('../utils/helpers');

class ReportController {
  /**
   * Emite demonstrativo para o cliente consolidando o volume enviado por suas lojas/nomes em um período.
   */
  static getClientReport(req, res) {
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
      const rows = Pacote.findClientReportData(clientList, dataInicio, dataFim);

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
  }

  /**
   * Relatório para conferência física de balcão. Filtro de data única e janela de horários.
   */
  static getConferenceReport(req, res) {
    const { data, horaInicio, horaFim } = req.query;

    if (!data || !horaInicio || !horaFim) {
      return res.status(400).send('Parâmetros "data", "horaInicio" e "horaFim" são obrigatórios.');
    }

    try {
      const rows = Pacote.findConferenceReportData(data, horaInicio, horaFim);
      const totalsRows = Pacote.findConferenceTotals(data, horaInicio, horaFim);
      
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
  }
}

module.exports = ReportController;
