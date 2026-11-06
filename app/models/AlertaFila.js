const { db } = require('../database');

class AlertaFila {
  /**
   * Insere um novo alerta de erro na fila (DLQ).
   * @param {Object} data Dados do alerta.
   * @returns {Object} Resultado do run.
   */
  static create(data) {
    const { tipo_erro, codigo_conflito, caminho_imagem_nova, data_criacao, hora_criacao, remetente_sugerido, plataforma_sugerida, pacote_id, detalhe } = data;
    const stmt = db.prepare(`
      INSERT INTO alertas_fila (tipo_erro, codigo_conflito, caminho_imagem_nova, data_criacao, hora_criacao, remetente_sugerido, plataforma_sugerida, pacote_id, detalhe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(tipo_erro, codigo_conflito, caminho_imagem_nova, data_criacao, hora_criacao ?? null, remetente_sugerido, plataforma_sugerida, pacote_id ?? null, detalhe ?? null);
  }

  /**
   * Remove alertas de um determinado tipo vinculados a um pacote existente
   * (evita alertas duplicados quando o mesmo pacote falha mais de uma vez no reprocessamento).
   * @param {number|string} pacoteId ID do pacote.
   * @param {string} tipoErro Tipo do alerta.
   * @returns {Object} Resultado do delete.
   */
  static deleteByPacoteId(pacoteId, tipoErro) {
    return db.prepare('DELETE FROM alertas_fila WHERE pacote_id = ? AND tipo_erro = ?').run(pacoteId, tipoErro);
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
    // LEFT JOIN traz os dados atuais do pacote (para alertas de reprocessamento),
    // permitindo ao operador comparar o valor atual com o sugerido pela nova leitura.
    return db.prepare(`
      SELECT a.id, a.tipo_erro, a.codigo_conflito, a.caminho_imagem_nova, a.data_criacao, a.hora_criacao,
             a.remetente_sugerido, a.plataforma_sugerida, a.pacote_id, a.detalhe,
             p.codigo_pacote AS pacote_codigo_atual,
             p.remetente_bruto AS pacote_remetente_atual,
             p.plataforma AS pacote_plataforma_atual
      FROM alertas_fila a
      LEFT JOIN pacotes p ON p.id = a.pacote_id
      ORDER BY a.id DESC
    `).all();
  }

  /**
   * Busca registros de alertas anteriores a uma data limite para rotina TTL.
   * @param {string} dateLimit Data limite (YYYY-MM-DD).
   * @returns {Array} Registros antigos.
   */
  static findOlderThan(dateLimit) {
    return db.prepare('SELECT id, caminho_imagem_nova, pacote_id FROM alertas_fila WHERE data_criacao < ?').all(dateLimit);
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
