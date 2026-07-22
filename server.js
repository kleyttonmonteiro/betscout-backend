/* ============================================================================
   SINAIS DE GOL — Backend único (server.js)
   Arquitetura em blocos:
   01 Imports e configuração inicial      09 Persistência do histórico (/data)
   02 ENV e constantes                    10 Lógica de análise e semáforo
   03 Inicialização do Express            11 Rotas da API
   04 Cache em memória                    12 Frontend estático
   05 Funções utilitárias                 13 Healthcheck
   06 Integração API-Football             14 Tratamento de erro
   07 Integração IA (Anthropic/Gemini)    15 Start do servidor
   08 Integração Telegram

   ATUALIZAÇÃO: agora o /api/analyze calcula primeiro um score interno
   (scoringService.js, sem custo) e só chama a IA externa quando o score
   cai numa faixa duvidosa. Isso reduz bastante o consumo de créditos.
   ==========================================================================*/

/* == 01. IMPORTS E CONFIGURAÇÃO INICIAL ================================== */
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { calcularAnalise, precisaDeIA } = require('./scoringService');

/* == 02. ENV E CONSTANTES ================================================ */
const {
  PORT = 3000,
  NODE_ENV = 'development',
  API_FOOTBALL_KEY = '',
  ANTHROPIC_API_KEY = '',
  GEMINI_API_KEY = '',
  TELEGRAM_BOT_TOKEN = '',
  TELEGRAM_CHAT_ID = '',
  DATA_DIR = '/data',
  ALLOWED_ORIGINS = '*',
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

/* == 03. INICIALIZAÇÃO DO EXPRESS ======================================== */
const app = express();
app.use(express.json({ limit: '200kb' }));

// CORS simples e seguro
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS === '*' || ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS === '*' ? '*' : origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
{"veredito":"ENTRAR|AGUARDAR|EVITAR","probabilidade":0-100,"risco":"BAIXO|MEDIO|ALTO","odd_minima":numero,"linha_sugerida":"texto","justificativa":"texto curto"}

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
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  return (data.content || []).map(c => c.text || '').join('');
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  }, { timeoutMs: 20000, retries: 1 });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
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

/* == 08. INTEGRAÇÃO TELEGRAM ============================================ */
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

/* == 09. PERSISTÊNCIA DO HISTÓRICO (/data) =============================== */
const ENTRIES_FILE = path.join(DATA_DIR, 'entries.json');
let saveQueue = Promise.resolve(); // serializa escritas (sem concorrência)

async function loadEntries() {
  try {
    const raw = await fsp.readFile(ENTRIES_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return []; }
}

function saveEntries(entries) {
  saveQueue = saveQueue.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = ENTRIES_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(entries, null, 2));
    await fsp.rename(tmp, ENTRIES_FILE); // escrita atômica
  }).catch(err => log('error', `Falha ao salvar histórico: ${err.message}`));
  return saveQueue;
}

// Resolve entradas pendentes consultando o placar final (GREEN/RED)
async function resolveEntries() {
  const entries = await loadEntries();
  const pending = entries.filter(e => e.status === 'PENDENTE');
  if (!pending.length) return entries;
  for (const e of pending) {
    try {
      const [fx] = await apiFootball(`/fixtures?id=${e.fixtureId}`);
      if (!fx || fx.fixture.status.short !== 'FT') continue;
      const total = num(fx.goals.home) + num(fx.goals.away);
      const line = parseFloat(String(e.linha).replace(/[^\d.]/g, ''));
      e.status = total > line ? 'GREEN' : 'RED';
      e.placar_final = `${fx.goals.home}x${fx.goals.away}`;
      e.resolvido_em = new Date().toISOString();
    } catch (err) {
      log('error', `Falha ao resolver entrada ${e.id}: ${err.message}`);
    }
  }
  await saveEntries(entries);
  return entries;
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
  const windowed = live.filter(inWindow);
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
      };
    }

    const result = { fixtureId: fx.fixture.id, jogo: `${payload.home} ${payload.goalsHome}x${payload.goalsAway} ${payload.away}`, minuto: payload.minute, cenario: scenario, semaforo: trafficLight(metrics), metricas: metrics, ...analysis };
    cacheSet(`analysis:${fixtureId}`, result, CFG.CACHE_TTL_ANALYSIS_MS);
    res.json(result);
  } catch (err) { next(err); }
});

// Registrar entrada (e disparar Telegram)
app.post('/api/entries', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.fixtureId || !b.linha) return res.status(400).json({ erro: 'fixtureId e linha são obrigatórios' });
    const entries = await loadEntries();
    const entry = {
      id: Date.now().toString(36),
      criado_em: new Date().toISOString(),
      status: 'PENDENTE',
      fixtureId: b.fixtureId, jogo: b.jogo || '', minuto: b.minuto || 0,
      cenario: b.cenario || '', linha: b.linha,
      probabilidade: b.probabilidade ?? null, risco: b.risco || '',
      odd_minima: b.odd_minima ?? null, justificativa: b.justificativa || '',
    };
    entries.unshift(entry);
    await saveEntries(entries);
    const telegram = await sendTelegramSignal(entry);
    res.status(201).json({ entrada: entry, telegram });
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
  let dataOk = false;
  try { await fsp.mkdir(DATA_DIR, { recursive: true }); await fsp.access(DATA_DIR); dataOk = true; } catch {}
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
      volume_data: dataOk,
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
app.listen(PORT, () => log('info', `Sinais de Gol rodando na porta ${PORT} (${NODE_ENV})`));
