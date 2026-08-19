/* ============================================================================
   db.js — Conexão com o banco de dados (Neon)

   Esse arquivo é só a "ponte" entre o programa e o banco de dados. Ele faz
   três coisas:
   1. Abre a conexão usando o endereço guardado na variável DATABASE_URL
   2. Cria (se ainda não existirem) duas tabelas — como se fossem duas
      planilhas dentro do banco:
      - "snapshots": vai guardar uma "foto" das estatísticas de cada jogo
        a cada consulta, pra no futuro calcular a tendência de pressão
        (isso é trabalho de uma etapa futura, aqui só criamos a planilha)
      - "trades": vai guardar o histórico de entradas registradas quando
        chegar a etapa do ticket de entrada (também uma etapa futura)
   3. Oferece uma forma simples de testar se a conexão está funcionando,
      usada pelo /healthcheck

   Nenhuma outra parte do programa usa essas tabelas ainda — essa etapa é
   só preparação, sem mudar nada do que já funciona hoje.
   ==========================================================================*/
const { Pool } = require('pg');

const { DATABASE_URL = '' } = process.env;

// Se a variável DATABASE_URL não estiver configurada, o programa continua
// funcionando normalmente (só sem as funções de banco de dados).
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// Cria as tabelas caso ainda não existam. Roda uma vez, quando o
// servidor liga.
async function initDb() {
  if (!pool) return false;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id SERIAL PRIMARY KEY,
        fixture_id INTEGER NOT NULL,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
        minuto INTEGER,
        placar_casa INTEGER,
        placar_fora INTEGER,
        cenario TEXT,
        semaforo TEXT,
        chutes_gol_casa INTEGER,
        chutes_gol_fora INTEGER,
        chutes_total_casa INTEGER,
        chutes_total_fora INTEGER,
        ataques_perigosos_casa INTEGER,
        ataques_perigosos_fora INTEGER,
        escanteios_casa INTEGER,
        escanteios_fora INTEGER,
        posse_casa NUMERIC,
        posse_fora NUMERIC,
        xg_casa NUMERIC,
        xg_fora NUMERIC
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
        fixture_id INTEGER NOT NULL,
        jogo TEXT,
        minuto INTEGER,
        cenario TEXT,
        linha TEXT,
        probabilidade NUMERIC,
        risco TEXT,
        odd_minima NUMERIC,
        justificativa TEXT,
        status TEXT DEFAULT 'PENDENTE',
        placar_final TEXT,
        resolvido_em TIMESTAMPTZ,
        stake NUMERIC,
        odd_executada NUMERIC,
        motivo TEXT
      );
    `);
    return true;
  } catch (err) {
    console.error('[db] Falha ao preparar as tabelas:', err.message);
    return false;
  }
}

// Testa rapidamente se o banco responde. Usado pelo /healthcheck pra
// mostrar database: true ou false de verdade, não só "a variável existe".
async function testConnection() {
  if (!pool) return false;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

module.exports = { pool, initDb, testConnection };
