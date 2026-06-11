const { db } = require('../database');

class AlertaFila {
  /**
   * Insere um novo alerta de erro na fila (DLQ).
   * @param {Object} data Dados do alerta.
   * @returns {Object} Resultado do run.
   */
  static create(data) {
    const { tipo_erro, codigo_conflito, caminho_imagem_nova, data_criacao, hora_criacao, remetente_sugerido, plataforma_sugerida } = data;
    const stmt = db.prepare(`
      INSERT INTO alertas_fila (tipo_erro, codigo_conflito, caminho_imagem_nova, data_criacao, hora_criacao, remetente_sugerido, plataforma_sugerida)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(tipo_erro, codigo_conflito, caminho_imagem_nova, data_criacao, hora_criacao ?? null, remetente_sugerido, plataforma_sugerida);
  }

  /**
   * Busca um alerta pelo ID.
   * @param {number|string} id ID do alerta.
   * @returns {Object|undefined} Alerta encontrado.
   */
  static findById(id) {
    return db.prepare('SELECT * FROM alertas_fila WHERE id = ?').get(id);
  }

  /**
   * Remove um alerta da fila.
   * @param {number|string} id ID do alerta.
   * @returns {Object} Resultado do delete.
   */
  static delete(id) {
    return db.prepare('DELETE FROM alertas_fila WHERE id = ?').run(id);
  }

  /**
   * Retorna todos os alertas ordenados do mais recente para o mais antigo.
   * @returns {Array} Lista de alertas.
   */
  static findAll() {
    return db.prepare(`
      SELECT id, tipo_erro, codigo_conflito, caminho_imagem_nova, data_criacao, hora_criacao, remetente_sugerido, plataforma_sugerida 
      FROM alertas_fila 
      ORDER BY id DESC
    `).all();
  }

  /**
   * Busca registros de alertas anteriores a uma data limite para rotina TTL.
   * @param {string} dateLimit Data limite (YYYY-MM-DD).
   * @returns {Array} Registros antigos.
   */
  static findOlderThan(dateLimit) {
    return db.prepare('SELECT id, caminho_imagem_nova FROM alertas_fila WHERE data_criacao < ?').all(dateLimit);
  }

  /**
   * Limpa alertas anteriores a uma determinada data.
   * @param {string} dateLimit Data limite (YYYY-MM-DD).
   * @returns {Object} Resultado da exclusão.
   */
  static deleteOlderThan(dateLimit) {
    return db.prepare('DELETE FROM alertas_fila WHERE data_criacao < ?').run(dateLimit);
  }
}

module.exports = AlertaFila;
