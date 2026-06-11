const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dbPath = process.env.DATABASE_PATH || 'coleta.db';
// Garante que o banco seja criado na raiz do projeto
const absoluteDbPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(__dirname, '..', dbPath);

// Garante que o diretório do banco de dados existe
const dbDir = path.dirname(absoluteDbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(absoluteDbPath);
db.pragma('journal_mode = WAL'); // Modo de alto desempenho

// Inicialização de tabelas
const initDb = () => {
  // Tabela: pacotes
  db.exec(`
    CREATE TABLE IF NOT EXISTS pacotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo_pacote TEXT,
      remetente_bruto TEXT NOT NULL,
      plataforma TEXT NOT NULL,
      caminho_imagem TEXT NOT NULL,
      data_coleta TEXT NOT NULL DEFAULT (date('now', 'localtime')),
      hora_coleta TEXT NOT NULL DEFAULT (time('now', 'localtime'))
    );
  `);

  // Tabela: alertas_fila
  db.exec(`
    CREATE TABLE IF NOT EXISTS alertas_fila (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_erro TEXT NOT NULL,
      codigo_conflito TEXT,
      caminho_imagem_nova TEXT NOT NULL,
      data_criacao TEXT NOT NULL DEFAULT (date('now', 'localtime')),
      hora_criacao TEXT,
      remetente_sugerido TEXT,
      plataforma_sugerida TEXT
    );
  `);

  // Índices para Otimização e Regras de Negócio
  // Regra de Único no Dia Corrente, exceto para 'NÃO IDENTIFICADO'
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_codigo_data 
    ON pacotes (codigo_pacote, data_coleta) 
    WHERE codigo_pacote IS NOT NULL AND codigo_pacote != 'NÃO IDENTIFICADO';
  `);

  // Índice para buscas no Histórico e Relatórios
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pacotes_data ON pacotes (data_coleta);
  `);

  // Índice para agrupamento de clientes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pacotes_remetente ON pacotes (remetente_bruto);
  `);

  // Índice para alertas por data
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alertas_data ON alertas_fila (data_criacao);
  `);

  // Migração dinâmica para bancos de dados existentes
  try {
    db.exec("ALTER TABLE alertas_fila ADD COLUMN remetente_sugerido TEXT;");
  } catch (e) {
    // A coluna já existe
  }
  try {
    db.exec("ALTER TABLE alertas_fila ADD COLUMN plataforma_sugerida TEXT;");
  } catch (e) {
    // A coluna já existe
  }
  try {
    db.exec("ALTER TABLE alertas_fila ADD COLUMN hora_criacao TEXT;");
  } catch (e) {
    // A coluna já existe
  }

  console.log(`Banco de dados inicializado em: ${absoluteDbPath}`);
};

module.exports = {
  db,
  initDb
};
