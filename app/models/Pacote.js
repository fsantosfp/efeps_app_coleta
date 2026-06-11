const { db } = require('../database');

class Pacote {
  /**
   * Insere um novo pacote no banco de dados.
   * @param {Object} data Dados do pacote.
   * @returns {Object} Resultado do comando run.
   */
  static create(data) {
    const { codigo_pacote, remetente_bruto, plataforma, caminho_imagem, data_coleta, hora_coleta } = data;
    const stmt = db.prepare(`
      INSERT INTO pacotes (codigo_pacote, remetente_bruto, plataforma, caminho_imagem, data_coleta, hora_coleta)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(codigo_pacote, remetente_bruto, plataforma, caminho_imagem, data_coleta, hora_coleta);
  }

  /**
   * Busca um pacote pelo ID.
   * @param {number|string} id ID do pacote.
   * @returns {Object|undefined} Pacote encontrado.
   */
  static findById(id) {
    return db.prepare('SELECT * FROM pacotes WHERE id = ?').get(id);
  }

  /**
   * Busca um pacote que crie conflito de duplicidade diária.
   * @param {string} codigo Código de barras do pacote.
   * @param {string} date Data da coleta (YYYY-MM-DD).
   * @param {number|string|null} excludeId Opcional. ID a ser excluído (ex: em edições).
   * @returns {Object|undefined} Registro em conflito.
   */
  static findDuplicate(codigo, date, excludeId = null) {
    if (excludeId !== null) {
      return db.prepare(`
        SELECT id FROM pacotes 
        WHERE codigo_pacote = ? AND data_coleta = ? AND id != ?
      `).get(codigo, date, excludeId);
    }
    return db.prepare(`
      SELECT id FROM pacotes 
      WHERE codigo_pacote = ? AND data_coleta = ?
    `).get(codigo, date);
  }

  /**
   * Busca as informações detalhadas de um pacote em conflito.
   * @param {string} codigo Código de barras do pacote.
   * @param {string} date Data da coleta (YYYY-MM-DD).
   * @returns {Object|undefined} Detalhes do pacote em conflito.
   */
  static findConflictPackage(codigo, date) {
    return db.prepare(`
      SELECT id, codigo_pacote, remetente_bruto, plataforma, hora_coleta, caminho_imagem 
      FROM pacotes 
      WHERE codigo_pacote = ? AND data_coleta = ?
      LIMIT 1
    `).get(codigo, date);
  }

  /**
   * Atualiza as informações básicas de um pacote.
   * @param {number|string} id ID do pacote.
   * @param {Object} data Dados a atualizar.
   * @returns {Object} Resultado do update.
   */
  static update(id, data) {
    const { codigo_pacote, remetente_bruto, plataforma } = data;
    const stmt = db.prepare(`
      UPDATE pacotes 
      SET codigo_pacote = ?, remetente_bruto = ?, plataforma = ? 
      WHERE id = ?
    `);
    return stmt.run(codigo_pacote, remetente_bruto, plataforma, id);
  }

  /**
   * Deleta um pacote pelo ID.
   * @param {number|string} id ID do pacote.
   * @returns {Object} Resultado do delete.
   */
  static delete(id) {
    return db.prepare('DELETE FROM pacotes WHERE id = ?').run(id);
  }

  /**
   * Busca pacotes por data com limite opcional.
   * @param {string} date Data da coleta (YYYY-MM-DD).
   * @param {number|null} limit Limite de registros.
   * @returns {Array} Lista de pacotes.
   */
  static findAllByDate(date, limit = null) {
    let query = `
      SELECT id, codigo_pacote, remetente_bruto, plataforma, hora_coleta, caminho_imagem 
      FROM pacotes 
      WHERE data_coleta = ?
      ORDER BY hora_coleta DESC, id DESC
    `;
    if (limit !== null) {
      query += ` LIMIT ${Number(limit)}`;
    }
    return db.prepare(query).all(date);
  }

  /**
   * Lista todos os remetentes únicos cadastrados para autocomplete.
   * @returns {Array} Lista de strings com os nomes dos remetentes.
   */
  static findDistinctClients() {
    const rows = db.prepare(`
      SELECT DISTINCT remetente_bruto FROM pacotes 
      ORDER BY remetente_bruto ASC
    `).all();
    return rows.map(r => r.remetente_bruto);
  }

  /**
   * Conta o volume de pacotes de uma plataforma em um dia específico.
   * @param {string} plataforma Plataforma (ex: 'Shopee').
   * @param {string} date Data da coleta (YYYY-MM-DD).
   * @returns {number} Quantidade de pacotes.
   */
  static countByPlataformaAndDate(plataforma, date) {
    const row = db.prepare(`
      SELECT COUNT(*) AS count FROM pacotes 
      WHERE plataforma = ? AND data_coleta = ?
    `).get(plataforma, date);
    return row ? row.count : 0;
  }

  /**
   * Busca dados de pacotes para emissão de relatório por cliente.
   * @param {Array<string>} clientList Lista de remetentes brutos.
   * @param {string} startDate Data início (YYYY-MM-DD).
   * @param {string} endDate Data fim (YYYY-MM-DD).
   * @returns {Array} Linhas encontradas.
   */
  static findClientReportData(clientList, startDate, endDate) {
    if (!clientList || clientList.length === 0) return [];
    const placeholders = clientList.map(() => '?').join(',');
    const query = `
      SELECT data_coleta, hora_coleta, codigo_pacote, plataforma, remetente_bruto 
      FROM pacotes 
      WHERE remetente_bruto IN (${placeholders}) 
        AND data_coleta BETWEEN ? AND ?
      ORDER BY data_coleta ASC, hora_coleta ASC
    `;
    return db.prepare(query).all(...clientList, startDate, endDate);
  }

  /**
   * Busca dados de pacotes agrupados por cliente e plataforma para relatório de conferência de balcão.
   * @param {string} date Data (YYYY-MM-DD).
   * @param {string} startTime Hora de início (HH:MM:SS).
   * @param {string} endTime Hora de fim (HH:MM:SS).
   * @returns {Array} Registros agrupados.
   */
  static findConferenceReportData(date, startTime, endTime) {
    const query = `
      SELECT remetente_bruto, plataforma, COUNT(*) AS quantidade
      FROM pacotes
      WHERE data_coleta = ? AND hora_coleta BETWEEN ? AND ?
      GROUP BY remetente_bruto, plataforma
      ORDER BY remetente_bruto ASC
    `;
    return db.prepare(query).all(date, startTime, endTime);
  }

  /**
   * Busca totais de pacotes por plataforma em um intervalo de tempo para relatório de conferência.
   * @param {string} date Data (YYYY-MM-DD).
   * @param {string} startTime Hora de início (HH:MM:SS).
   * @param {string} endTime Hora de fim (HH:MM:SS).
   * @returns {Array} Totais agrupados.
   */
  static findConferenceTotals(date, startTime, endTime) {
    const query = `
      SELECT plataforma, COUNT(*) AS quantidade
      FROM pacotes
      WHERE data_coleta = ? AND hora_coleta BETWEEN ? AND ?
      GROUP BY plataforma
    `;
    return db.prepare(query).all(date, startTime, endTime);
  }

  /**
   * Busca registros de pacotes anteriores a uma data limite para rotina TTL.
   * @param {string} dateLimit Data limite (YYYY-MM-DD).
   * @returns {Array} Registros antigos.
   */
  static findOlderThan(dateLimit) {
    return db.prepare('SELECT id, caminho_imagem FROM pacotes WHERE data_coleta < ?').all(dateLimit);
  }

  /**
   * Remove registros de pacotes com mais de N dias para rotina TTL.
   * @param {string} dateLimit Data limite (YYYY-MM-DD).
   * @returns {Object} Resultado do delete.
   */
  static deleteOlderThan(dateLimit) {
    return db.prepare('DELETE FROM pacotes WHERE data_coleta < ?').run(dateLimit);
  }
}

module.exports = Pacote;
