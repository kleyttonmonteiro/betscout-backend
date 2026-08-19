/* ============================================================================
   ALERTA DE GOL — Backend único (server.js)
   Arquitetura em blocos:
   01 Imports e configuração inicial      09 Persistência do histórico (banco)
   02 ENV e constantes                    10 Lógica de análise e semáforo
   03 Inicialização do Express            11 Rotas da API
   04 Cache em memória                    12 Frontend estático
   05 Funções utilitárias                 13 Healthcheck
   06 Integração API-Football             14 Tratamento de erro
   07 Integração IA (Anthropic/Gemini)    15 Start do servidor
   08 Integração Telegram (não é mais chamada automaticamente ao registrar
      entrada — função mantida no código, disponível para uso manual futuro)

   ATUALIZAÇÃO: agora o /api/analyze calcula primeiro um score interno
   (scoringService.js, sem custo) e só chama a IA externa quando o score
   cai numa faixa duvidosa. Isso reduz bastante o consumo de créditos.

   ATUALIZAÇÃO 2: o servidor se conecta ao banco de dados (arquivo db.js) e
   cria as tabelas de preparação (snapshots e trades).

   ATUALIZAÇÃO 3: o histórico de entradas (registrar entrada / ver entradas /
   resolver GREEN-RED) deixou de ser guardado num arquivo local (que não
   sobrevivia a reinícios no Render) e passou a ser guardado direto no banco
   de dados, na tabela "trades" — agora é permanente de verdade.

   ATUALIZAÇÃO 4: adicionado login por senha única. Todas as rotas /api/*
   (exceto /api/login) agora exigem um token válido, obtido ao entrar com a
   senha. Sem isso, qualquer pessoa com o link do app conseguia ver e mexer
   nos seus dados. O /healthcheck continua público de propósito, pra o
   UptimeRobot conseguir pingar sem precisar de senha.

   ATUALIZAÇÃO 5 (Fase 3 — novo contrato de resposta da IA): tanto o motor
   próprio (scoringService.js) quanto a IA externa agora sempre devolvem
   também "janela" (por quanto tempo o sinal vale), "gatilho" (o que
   disparou o sinal) e "invalidacao" (quando descartar o sinal), além dos
   campos que já existiam. Isso prepara o terreno pro card novo do Radar
   (Fase 2), que ainda vai ser feito.

   ATUALIZAÇÃO 6: rota de teste /api/test-analyze — roda o motor de análise
   com estatísticas inventadas, pra conferir o contrato novo sem precisar
   de nenhum jogo real ao vivo. Continua exigindo login.

   ATUALIZAÇÃO 7: modelo do Gemini corrigido de "gemini-2.0-flash" (esse
   modelo foi desativado pelo Google) para "gemini-3.6-flash" — nome
   confirmado pela própria resposta de erro da API do Google.

   ATUALIZAÇÃO 8: os erros de Anthropic/Gemini agora guardam o texto
   completo devolvido pela API no log, não só o código HTTP. Isso ajuda a
   diagnosticar problemas como "chave sem crédito" ou "modelo errado" sem
   precisar adivinhar.
   ==========================================================================*/

/* == 01. IMPORTS E CONFIGURAÇÃO INICIAL ================================== */
const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const { calcularAnalise, precisaDeIA } = require('./scoringService');
const { initDb, testConnection, pool } = require('./db');

/* == 02. ENV E CONSTANTES ================================================ */
const {
  PORT = 3000,
  NODE_ENV = 'development',
  API_FOOTBALL_KEY = '',
  ANTHROPIC_API_KEY = '',
  GEMINI_API_KEY = '',
  TELEGRAM_BOT_TOKEN = '',
  TELEGRAM_CHAT_ID = '',
  ALLOWED_ORIGINS = '*',
  APP_PASSWORD = '',
  JWT_SECRET = '',
} = process.env;

// Tempos e limites centralizados (nada de números mágicos espalhados)
const CFG = {
  CACHE_TTL_GAMES_MS: 90 * 1000,      // lista de jogos ao vivo
  CACHE_TTL_STATS_MS: 60 * 1000,      // estatísticas por fixture
  CACHE_TTL_ODDS_MS: 6 * 60 * 60e3,   // odds pré-jogo (não mudam ao vivo)
  CACHE_TTL_ANALYSIS_MS: 3 * 60e3,    // resultado de análise de IA
  HTTP_TIMEOUT_MS: 8000,
  HTTP_RETRIES: 2,
  LOG_MAX: 200,
};

// Regras de entrada (spec atualizada)
const RULES = {
  FAVORITE_MAX_ODD: 1.60,             // favorito = menor odd pré-jogo no 1x2
  WINDOW_1H_FROM: 30,                 // 1º tempo: a partir dos 30'
  WINDOW_2H_FROM: 70,                 // 2º tempo: a partir dos 70'
  // Cenários válidos: 0x0 | favorito perdendo 0x1 | 1x1
  // Linha de gols dinâmica: sempre uma linha acima do "gol seguinte"
  LINES: { '0x0': ['Over 1.5', 'Over 2.5'], '0x1': ['Over 2.5'], '1x1': ['Over 2.5', 'Over 3.5'] },
};

const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

// Lista das competições que realmente interessam (26 no total, depois de
// tirar Turquia e Dinamarca). Jogos de ligas fora dessa lista são
// descartados logo na janela de tempo, antes de gastar qualquer consulta
// extra pra descobrir o favorito.
const LEAGUE_WHITELIST = {
  // Inglaterra
  39: 'Premier League', 40: 'Championship', 45: 'FA Cup',
  // França
  61: 'Ligue 1', 62: 'Ligue 2', 66: 'Coupe de France',
  // Alemanha
  78: 'Bundesliga', 79: '2. Bundesliga', 81: 'DFB Pokal',
  // Espanha
  140: 'La Liga', 141: 'La Liga 2', 143: 'Copa del Rey',
  // Itália
  135: 'Serie A (ITA)', 136: 'Serie B (ITA)', 137: 'Coppa Italia',
  // Portugal
  94: 'Primeira Liga', 95: 'Liga Portugal 2', 96: 'Taça de Portugal',
  // Brasil
  71: 'Brasileirão Série A', 72: 'Brasileirão Série B', 73: 'Copa do Brasil',
  // Continentais
  2: 'Champions League', 3: 'Europa League', 848: 'Conference League',
  13: 'Copa Libertadores', 11: 'Copa Sul-Americana',
};
const LEAGUE_IDS = new Set(Object.keys(LEAGUE_WHITELIST).map(Number));

/* == 03. INICIALIZAÇÃO DO EXPRESS ======================================== */
const app = express();
app.use(express.json({ limit: '200kb' }));

// CORS simples e seguro
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS === '*' || ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS === '*' ? '*' : origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* == 04. CACHE EM MEMÓRIA ================================================ */
const cache = new Map(); // key -> { value, expiresAt }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/* == 05. FUNÇÕES UTILITÁRIAS ============================================ */
const logs = []; // ring buffer em memória
function log(level, msg, extra) {
  const entry = { ts: new Date().toISOString(), level, msg, ...(extra ? { extra } : {}) };
  logs.push(entry);
  if (logs.length > CFG.LOG_MAX) logs.shift();
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](`[${entry.ts}] ${level.toUpperCase()} ${msg}`);
}

async function fetchWithTimeout(url, options = {}, { timeoutMs = CFG.HTTP_TIMEOUT_MS, retries = CFG.HTTP_RETRIES } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (res.status >= 500 && attempt < retries) continue; // retry só em erro de servidor
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 400 * (attempt + 1))); // backoff
    }
  }
}

const num = v => (typeof v === 'string' ? parseFloat(v.replace('%', '')) : (v ?? 0)) || 0;

/* == 06. INTEGRAÇÃO API-FOOTBALL ======================================== */
async function apiFootball(pathAndQuery) {
  const res = await fetchWithTimeout(`${API_FOOTBALL_BASE}${pathAndQuery}`, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY },
  });
  if (!res.ok) throw new Error(`API-Football ${res.status} em ${pathAndQuery}`);
  const json = await res.json();
  return json.response || [];
}

async function getLiveFixtures() {
  const cached = cacheGet('live');
  if (cached) return cached;
  const data = await apiFootball('/fixtures?live=all');
  log('info', `API-Football: ${data.length} jogos ao vivo`);
  return cacheSet('live', data, CFG.CACHE_TTL_GAMES_MS);
}

async function getFixtureStats(fixtureId) {
  const key = `stats:${fixtureId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await apiFootball(`/fixtures/statistics?fixture=${fixtureId}`);
  return cacheSet(key, data, CFG.CACHE_TTL_STATS_MS);
}

// Favorito = time com a menor odd pré-jogo no mercado 1x2 (Match Winner)
async function getFavorite(fixtureId) {
  const key = `fav:${fixtureId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const data = await apiFootball(`/odds?fixture=${fixtureId}&bet=1`);
    const values = data?.[0]?.bookmakers?.[0]?.bets?.[0]?.values || [];
    const home = num(values.find(v => v.value === 'Home')?.odd);
    const away = num(values.find(v => v.value === 'Away')?.odd);
    let fav = null;
    if (home && away) {
      const side = home <= away ? 'home' : 'away';
      const odd = Math.min(home, away);
      fav = { side, odd, isStrong: odd <= RULES.FAVORITE_MAX_ODD };
    }
    return cacheSet(key, fav, CFG.CACHE_TTL_ODDS_MS);
  } catch (err) {
    log('error', `Odds indisponíveis para fixture ${fixtureId}: ${err.message}`);
    return cacheSet(key, null, CFG.CACHE_TTL_ODDS_MS); // não repete chamada com erro
  }
}

// Extrai métricas relevantes do payload de estatísticas
function extractMetrics(statsResponse) {
  const bySide = side => {
    const raw = statsResponse?.[side === 'home' ? 0 : 1]?.statistics || [];
    const pick = name => num(raw.find(s => s.type === name)?.value);
    return {
      chutes_no_gol: pick('Shots on Goal'),
      chutes_total: pick('Total Shots'),
      ataques_perigosos: pick('Dangerous Attacks'), // "radar de calor" / attack momentum
      escanteios: pick('Corner Kicks'),
      posse: pick('Ball Possession'),
      xg: pick('expected_goals'),
    };
  };
  return { home: bySide('home'), away: bySide('away') };
}

/* == 07. INTEGRAÇÃO IA (ANTHROPIC COM FALLBACK GEMINI) =================== */
function buildPrompt(payload) {
  return `Você é um analista de apostas ao vivo especializado em mercados de gols (Over).
Analise o jogo abaixo e responda SOMENTE com JSON válido, sem markdown, no formato:
{"veredito":"ENTRAR|AGUARDAR|EVITAR","probabilidade":0-100,"risco":"BAIXO|MEDIO|ALTO","odd_minima":numero,"linha_sugerida":"texto","justificativa":"texto curto","janela":"texto curto dizendo por quanto tempo esse sinal ainda vale (ex: Próximos 8 minutos (72'-80'))","gatilho":"texto curto dizendo qual foi o principal fator estatístico que motivou esse veredito","invalidacao":"texto curto dizendo em que situação esse sinal deve ser descartado"}

Jogo: ${payload.home} ${payload.goalsHome} x ${payload.goalsAway} ${payload.away} — ${payload.minute}' (${payload.half}º tempo)
Cenário: ${payload.scenario} | Favorito: ${payload.favoriteName || 'indefinido'} (odd pré ${payload.favoriteOdd || 'n/d'})
Linhas alvo: ${payload.lines.join(' ou ')}
Estatísticas (casa | fora):
- Chutes no gol: ${payload.metrics.home.chutes_no_gol} | ${payload.metrics.away.chutes_no_gol}
- Chutes totais: ${payload.metrics.home.chutes_total} | ${payload.metrics.away.chutes_total}
- Ataques perigosos: ${payload.metrics.home.ataques_perigosos} | ${payload.metrics.away.ataques_perigosos}
- Escanteios: ${payload.metrics.home.escanteios} | ${payload.metrics.away.escanteios}
- Posse: ${payload.metrics.home.posse}% | ${payload.metrics.away.posse}%
Considere ritmo por minuto, pressão do favorito e a linha de gols acima do gol seguinte.`;
}

async function callAnthropic(prompt) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  }, { timeoutMs: 20000, retries: 1 });
  if (!res.ok) {
    const corpo = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${corpo.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || []).map(c => c.text || '').join('');
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  }, { timeoutMs: 20000, retries: 1 });
  if (!res.ok) {
    const corpo = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${corpo.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
}

function parseAIJson(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  return JSON.parse(clean.slice(start, end + 1));
}

async function analyzeWithAI(payload) {
  const prompt = buildPrompt(payload);
  const providers = [];
  if (ANTHROPIC_API_KEY) providers.push(['anthropic', callAnthropic]);
  if (GEMINI_API_KEY) providers.push(['gemini', callGemini]);
  if (!providers.length) throw new Error('Nenhuma chave de IA configurada (ANTHROPIC_API_KEY ou GEMINI_API_KEY)');

  let lastErr;
  for (const [name, fn] of providers) {
    try {
      const text = await fn(prompt);
      const parsed = parseAIJson(text);
      return { provedor: name, ...parsed };
    } catch (err) {
      lastErr = err;
      log('error', `IA (${name}) falhou: ${err.message} — tentando fallback`);
    }
  }
  throw lastErr;
}

/* == 08. INTEGRAÇÃO TELEGRAM ============================================
   Não é mais chamada automaticamente ao registrar uma entrada (removido
   por decisão do usuário). A função continua aqui, pronta para ser
   acionada manualmente no futuro se fizer sentido. */
async function sendTelegramSignal(entry) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  const text =
    `⚽ SINAL — ${entry.linha}\n` +
    `${entry.jogo} (${entry.minuto}')\n` +
    `Cenário: ${entry.cenario} | Prob: ${entry.probabilidade}% | Risco: ${entry.risco}\n` +
    `Odd mínima: ${entry.odd_minima}\n` +
    `${entry.justificativa}`;
  try {
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    return res.ok;
  } catch (err) {
    log('error', `Telegram falhou: ${err.message}`);
    return false;
  }
}

/* == 09. PERSISTÊNCIA DO HISTÓRICO (BANCO DE DADOS) =======================
   Antes isso era guardado num arquivo dentro do servidor (/data). No Render
   gratuito esse arquivo não sobrevive a reinícios, então trocamos pra
   guardar direto na tabela "trades" do banco de dados (Neon), que é
   permanente de verdade. */

// Converte uma linha da tabela trades pro formato que o frontend já espera
function rowToEntry(r) {
  return {
    id: r.id,
    criado_em: r.criado_em,
    status: r.status,
    fixtureId: r.fixture_id,
    jogo: r.jogo,
    minuto: r.minuto,
    cenario: r.cenario,
    linha: r.linha,
    probabilidade: r.probabilidade,
    risco: r.risco,
    odd_minima: r.odd_minima,
    justificativa: r.justificativa,
    placar_final: r.placar_final,
    resolvido_em: r.resolvido_em,
  };
}

async function loadEntries() {
  if (!pool) return [];
  const { rows } = await pool.query('SELECT * FROM trades ORDER BY criado_em DESC');
  return rows.map(rowToEntry);
}

async function saveEntry(entry) {
  await pool.query(
    `INSERT INTO trades
       (id, fixture_id, jogo, minuto, cenario, linha, probabilidade, risco, odd_minima, justificativa, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      entry.id, entry.fixtureId, entry.jogo, entry.minuto, entry.cenario, entry.linha,
      entry.probabilidade, entry.risco, entry.odd_minima, entry.justificativa, entry.status,
    ]
  );
}

async function updateEntryResult(id, status, placarFinal) {
  await pool.query(
    `UPDATE trades SET status = $1, placar_final = $2, resolvido_em = now() WHERE id = $3`,
    [status, placarFinal, id]
  );
}

// Resolve entradas pendentes consultando o placar final (GREEN/RED)
async function resolveEntries() {
  const entries = await loadEntries();
  const pending = entries.filter(e => e.status === 'PENDENTE');
  for (const e of pending) {
    try {
      const [fx] = await apiFootball(`/fixtures?id=${e.fixtureId}`);
      if (!fx || fx.fixture.status.short !== 'FT') continue;
      const total = num(fx.goals.home) + num(fx.goals.away);
      const line = parseFloat(String(e.linha).replace(/[^\d.]/g, ''));
      const status = total > line ? 'GREEN' : 'RED';
      const placarFinal = `${fx.goals.home}x${fx.goals.away}`;
      await updateEntryResult(e.id, status, placarFinal);
    } catch (err) {
      log('error', `Falha ao resolver entrada ${e.id}: ${err.message}`);
    }
  }
  return loadEntries();
}

/* == 10. LÓGICA DE ANÁLISE E SEMÁFORO =================================== */
function getScenario(fixture, favorite) {
  const gh = num(fixture.goals.home);
  const ga = num(fixture.goals.away);
  if (gh === 0 && ga === 0) return '0x0';
  if (gh === 1 && ga === 1) return '1x1';
  // 0x1: só vale se o FAVORITO estiver perdendo
  if (gh + ga === 1 && favorite?.isStrong) {
    const favLosing = (favorite.side === 'home' && ga === 1) || (favorite.side === 'away' && gh === 1);
    if (favLosing) return '0x1';
  }
  return null;
}

function inWindow(fixture) {
  const short = fixture.fixture.status.short; // 1H, HT, 2H...
  const min = num(fixture.fixture.status.elapsed);
  if (short === '1H') return min >= RULES.WINDOW_1H_FROM;
  if (short === '2H') return min >= RULES.WINDOW_2H_FROM;
  return false;
}

// Semáforo heurístico (sem IA): verde = pressão alta, amarelo = observar, vermelho = frio
function trafficLight(metrics) {
  const sog = metrics.home.chutes_no_gol + metrics.away.chutes_no_gol;
  const da = metrics.home.ataques_perigosos + metrics.away.ataques_perigosos;
  const corners = metrics.home.escanteios + metrics.away.escanteios;
  const score = sog * 2 + corners * 0.5 + da / 20;
  if (sog >= 6 || score >= 14) return 'verde';
  if (sog >= 3 || score >= 8) return 'amarelo';
  return 'vermelho';
}

// Converte o nível de risco do motor próprio (minúsculo/acento) pro mesmo
// padrão que a IA já usa (BAIXO/MEDIO/ALTO), pra não quebrar o frontend.
const RISCO_MAP = { baixo: 'BAIXO', 'médio': 'MEDIO', alto: 'ALTO' };

// Monta a lista final de candidatos para o frontend
async function buildCandidates() {
  const live = await getLiveFixtures();
  const windowed = live.filter(inWindow).filter(fx => LEAGUE_IDS.has(fx.league.id));
  const out = [];
  for (const fx of windowed) {
    const favorite = await getFavorite(fx.fixture.id);
    const scenario = getScenario(fx, favorite);
    if (!scenario) continue;
    out.push({
      fixtureId: fx.fixture.id,
      liga: `${fx.league.name} (${fx.league.country})`,
      casa: fx.teams.home.name,
      fora: fx.teams.away.name,
      placar: `${fx.goals.home}x${fx.goals.away}`,
      minuto: num(fx.fixture.status.elapsed),
      tempo: fx.fixture.status.short === '1H' ? 1 : 2,
      cenario: scenario,
      linhas: RULES.LINES[scenario],
      favorito: favorite ? { lado: favorite.side, odd: favorite.odd, forte: favorite.isStrong } : null,
    });
  }
  return out;
}

/* == 11. ROTAS DA API ==================================================== */

// ---- Login (fica ANTES da trava, é a única rota /api que fica aberta) ----
app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD || !JWT_SECRET) {
    return res.status(503).json({ erro: 'Login não configurado no servidor (faltam APP_PASSWORD/JWT_SECRET)' });
  }
  const { senha } = req.body || {};
  if (senha !== APP_PASSWORD) {
    return res.status(401).json({ erro: 'Senha incorreta' });
  }
  const token = jwt.sign({ ok: true }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

// ---- Trava: a partir daqui, toda rota /api/* exige token válido ----
function exigirLogin(req, res, next) {
  if (!APP_PASSWORD || !JWT_SECRET) return next(); // login não configurado: não bloqueia (evita travar o app à toa)
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Faça login' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: 'Sessão expirada, faça login novamente' });
  }
}
app.use('/api', exigirLogin);

app.get('/api/games', async (req, res, next) => {
  try {
    res.json({ atualizado_em: new Date().toISOString(), jogos: await buildCandidates() });
  } catch (err) { next(err); }
});

app.post('/api/analyze', async (req, res, next) => {
  try {
    const { fixtureId } = req.body || {};
    if (!fixtureId) return res.status(400).json({ erro: 'fixtureId é obrigatório' });

    const cachedAnalysis = cacheGet(`analysis:${fixtureId}`);
    if (cachedAnalysis) return res.json({ ...cachedAnalysis, cache: true });

    const live = await getLiveFixtures();
    const fx = live.find(f => f.fixture.id === Number(fixtureId));
    if (!fx) return res.status(404).json({ erro: 'Jogo não está mais ao vivo' });

    const favorite = await getFavorite(fx.fixture.id);
    const scenario = getScenario(fx, favorite) || `${fx.goals.home}x${fx.goals.away}`;
    const stats = await getFixtureStats(fx.fixture.id);
    const metrics = extractMetrics(stats);

    const payload = {
      home: fx.teams.home.name, away: fx.teams.away.name,
      goalsHome: fx.goals.home, goalsAway: fx.goals.away,
      minute: num(fx.fixture.status.elapsed),
      half: fx.fixture.status.short === '1H' ? 1 : 2,
      scenario,
      lines: RULES.LINES[scenario] || ['Over ' + (num(fx.goals.home) + num(fx.goals.away) + 0.5 + 1)],
      favoriteName: favorite ? fx.teams[favorite.side].name : null,
      favoriteOdd: favorite?.odd || null,
      metrics,
    };

    // ---- MOTOR DE PONTUAÇÃO PRÓPRIO (sem custo, roda sempre primeiro) ----
    const statsParaScore = {
      chutesGolCasa: metrics.home.chutes_no_gol,
      chutesGolFora: metrics.away.chutes_no_gol,
      ataquesPerigososCasa: metrics.home.ataques_perigosos,
      ataquesPerigososFora: metrics.away.ataques_perigosos,
      escanteiosCasa: metrics.home.escanteios,
      escanteiosFora: metrics.away.escanteios,
      xgCasa: metrics.home.xg,
      xgFora: metrics.away.xg,
    };
    const contextoScore = { cenario: scenario, linhaAlvo: payload.lines[0], minuto: payload.minute };
    const analisePropria = calcularAnalise(statsParaScore, contextoScore);

    let analysis;
    if (precisaDeIA(analisePropria.score_interno)) {
      // Score em faixa duvidosa: só aqui vale gastar crédito de IA
      analysis = await analyzeWithAI(payload);
      // Rede de segurança: se a IA esquecer algum campo novo do contrato,
      // usa um valor padrão em vez de deixar o frontend quebrado.
      analysis.janela = analysis.janela || 'Não informado';
      analysis.gatilho = analysis.gatilho || analysis.justificativa || 'Não informado';
      analysis.invalidacao = analysis.invalidacao || 'Reavalie se a pressão cair nos próximos minutos.';
    } else {
      // Score já é claro o suficiente: responde sem gastar IA nenhuma
      analysis = {
        provedor: 'motor_proprio',
        veredito: analisePropria.veredito,
        probabilidade: analisePropria.probabilidade,
        risco: RISCO_MAP[analisePropria.nivel_risco] || String(analisePropria.nivel_risco).toUpperCase(),
        odd_minima: analisePropria.sugestao_odd_minima,
        linha_sugerida: analisePropria.linha_sugerida,
        justificativa: analisePropria.justificativa,
        janela: analisePropria.janela,
        gatilho: analisePropria.gatilho,
        invalidacao: analisePropria.invalidacao,
      };
    }

    const result = { fixtureId: fx.fixture.id, jogo: `${payload.home} ${payload.goalsHome}x${payload.goalsAway} ${payload.away}`, minuto: payload.minute, cenario: scenario, semaforo: trafficLight(metrics), metricas: metrics, ...analysis };
    cacheSet(`analysis:${fixtureId}`, result, CFG.CACHE_TTL_ANALYSIS_MS);
    res.json(result);
  } catch (err) { next(err); }
});

// ---- Rota de TESTE (temporária): roda o motor de análise com estatísticas
// inventadas, sem precisar de nenhum jogo real ao vivo. Continua exigindo
// login (está depois da trava /api). Use ?duvidoso=1 pra forçar o caminho
// que chama a IA externa em vez do motor próprio. ----
app.get('/api/test-analyze', async (req, res, next) => {
  try {
    const statsParaScore = req.query.duvidoso
      ? { // score no meio do caminho: cai na faixa duvidosa e chama a IA de verdade
          chutesGolCasa: 2, chutesGolFora: 2,
          ataquesPerigososCasa: 25, ataquesPerigososFora: 25,
          escanteiosCasa: 2, escanteiosFora: 2,
          xgCasa: 0.6, xgFora: 0.6,
        }
      : { // score claramente alto: motor próprio resolve sozinho, sem gastar IA
          chutesGolCasa: 4, chutesGolFora: 3,
          ataquesPerigososCasa: 55, ataquesPerigososFora: 40,
          escanteiosCasa: 4, escanteiosFora: 3,
          xgCasa: 0.9, xgFora: 0.7,
        };
    const contextoScore = { cenario: '0x0', linhaAlvo: 'Over 1.5', minuto: 72 };
    const analisePropria = calcularAnalise(statsParaScore, contextoScore);

    let analysis;
    if (precisaDeIA(analisePropria.score_interno)) {
      analysis = await analyzeWithAI({
        home: 'Time Teste Casa', away: 'Time Teste Fora',
        goalsHome: 0, goalsAway: 0, minute: 72, half: 2,
        scenario: '0x0', lines: ['Over 1.5', 'Over 2.5'],
        favoriteName: 'Time Teste Casa', favoriteOdd: 1.45,
        metrics: {
          home: { chutes_no_gol: statsParaScore.chutesGolCasa, chutes_total: 8, ataques_perigosos: statsParaScore.ataquesPerigososCasa, escanteios: statsParaScore.escanteiosCasa, posse: 55, xg: statsParaScore.xgCasa },
          away: { chutes_no_gol: statsParaScore.chutesGolFora, chutes_total: 6, ataques_perigosos: statsParaScore.ataquesPerigososFora, escanteios: statsParaScore.escanteiosFora, posse: 45, xg: statsParaScore.xgFora },
        },
      });
      analysis.janela = analysis.janela || 'Não informado';
      analysis.gatilho = analysis.gatilho || analysis.justificativa || 'Não informado';
      analysis.invalidacao = analysis.invalidacao || 'Reavalie se a pressão cair nos próximos minutos.';
    } else {
      analysis = {
        provedor: 'motor_proprio',
        veredito: analisePropria.veredito,
        probabilidade: analisePropria.probabilidade,
        risco: RISCO_MAP[analisePropria.nivel_risco] || String(analisePropria.nivel_risco).toUpperCase(),
        odd_minima: analisePropria.sugestao_odd_minima,
        linha_sugerida: analisePropria.linha_sugerida,
        justificativa: analisePropria.justificativa,
        janela: analisePropria.janela,
        gatilho: analisePropria.gatilho,
        invalidacao: analisePropria.invalidacao,
      };
    }

    res.json({ aviso: 'SIMULAÇÃO DE TESTE — dados inventados, não é um jogo real', ...analysis });
  } catch (err) { next(err); }
});

// Registrar entrada (agora salva direto no banco de dados, de forma permanente)
app.post('/api/entries', async (req, res, next) => {
  try {
    if (!pool) return res.status(503).json({ erro: 'Banco de dados não configurado' });
    const b = req.body || {};
    if (!b.fixtureId || !b.linha) return res.status(400).json({ erro: 'fixtureId e linha são obrigatórios' });
    const entry = {
      id: Date.now().toString(36),
      status: 'PENDENTE',
      fixtureId: b.fixtureId, jogo: b.jogo || '', minuto: b.minuto || 0,
      cenario: b.cenario || '', linha: b.linha,
      probabilidade: b.probabilidade ?? null, risco: b.risco || '',
      odd_minima: b.odd_minima ?? null, justificativa: b.justificativa || '',
    };
    await saveEntry(entry);
    res.status(201).json({ entrada: entry });
  } catch (err) { next(err); }
});

app.get('/api/entries', async (req, res, next) => {
  try { res.json(await loadEntries()); } catch (err) { next(err); }
});

app.post('/api/entries/resolve', async (req, res, next) => {
  try { res.json(await resolveEntries()); } catch (err) { next(err); }
});

app.get('/api/log', (req, res) => res.json(logs.slice().reverse()));

/* == 12. FRONTEND ESTÁTICO ============================================== */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: NODE_ENV === 'production' ? '1h' : 0 }));

/* == 13. HEALTHCHECK ===================================================== */
app.get('/healthcheck', async (req, res) => {
  const dbOk = await testConnection();
  res.json({
    status: 'ok',
    ambiente: NODE_ENV,
    uptime_s: Math.round(process.uptime()),
    memoria_mb: Math.round(process.memoryUsage().rss / 1048576),
    integracoes: {
      api_football: Boolean(API_FOOTBALL_KEY),
      anthropic: Boolean(ANTHROPIC_API_KEY),
      gemini: Boolean(GEMINI_API_KEY),
      telegram: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      database: dbOk,
      login: Boolean(APP_PASSWORD && JWT_SECRET),
    },
    cache_itens: cache.size,
  });
});

/* == 14. TRATAMENTO DE ERRO ============================================= */
app.use((err, req, res, next) => {
  log('error', `${req.method} ${req.path} → ${err.message}`);
  res.status(502).json({ erro: 'Falha ao processar a requisição', detalhe: err.message });
});

/* == 15. START DO SERVIDOR ============================================== */
initDb().then(ok => {
  log('info', ok
    ? 'Banco de dados conectado e tabelas prontas (snapshots e trades)'
    : 'Banco de dados não configurado ou indisponível (registro de entradas não vai funcionar até isso ser corrigido)');
});

if (!APP_PASSWORD || !JWT_SECRET) {
  log('info', 'Login por senha NÃO configurado (faltam APP_PASSWORD e/ou JWT_SECRET) — app está aberto sem proteção.');
}

app.listen(PORT, () => log('info', `Alerta de Gol rodando na porta ${PORT} (${NODE_ENV})`));
