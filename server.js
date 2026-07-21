
const express = require("express");
const cors    = require("cors");
const axios   = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY  = process.env.API_FOOTBALL_KEY || "4283613a9df421f35d51f9b1f4b9576c";
const API_HOST = "v3.football.api-sports.io";
const headers  = { "x-apisports-key": API_KEY };

// ── Contagem de requisições diárias ──────────────────────────────────
let reqCount = 0;
let reqDay   = new Date().toDateString();
function trackReq(n = 1) {
  const today = new Date().toDateString();
  if (today !== reqDay) { reqCount = 0; reqDay = today; }
  reqCount += n;
}

// ── Cache principal (lista de jogos) — TTL 90s ────────────────────────
const LIVE_TTL = 90 * 1000;
let liveCache = { data: null, fetchedAt: 0, pending: null };

// ── Cache de odds pré-jogo por fixture_id — TTL 6h ───────────────────
// Odds pré-jogo não mudam durante a partida — buscamos uma vez e guardamos.
const ODDS_TTL = 6 * 60 * 60 * 1000;
let oddsCache  = {}; // { [fixtureId]: { odd_home, odd_away, favorito, fetchedAt } }

// ── Regras da spec ────────────────────────────────────────────────────
// Favorito = time com menor odd pré-jogo 1X2 (tipicamente ≤ 1.60)
// Cenários válidos: 0x0 | favorito PERDENDO (0x1) | 1x1
// Janelas: 1º tempo ≥ 30' | 2º tempo ≥ 70'
// Linha de gols dinâmica conforme placar:
//   0x0 → Over 1.5 / Over 2.5
//   0x1 ou 1x0 favorito perdendo → Over 2.5
//   1x1 → Over 2.5 / Over 3.5

function cenarioValido(m) {
  const h = m.score_home;
  const a = m.score_away;
  const fav = m.favorito; // 'home' | 'away' | null

  // 0x0 — sempre válido
  if (h === 0 && a === 0) return true;

  // 1x1 — válido
  if (h === 1 && a === 1) return true;

  // Favorito PERDENDO (0x1 do ponto de vista do favorito)
  if (fav === 'home' && h === 0 && a === 1) return true;
  if (fav === 'away' && a === 0 && h === 1) return true;

  return false;
}

function janelaValida(m) {
  const min    = m.minute;
  const status = m.status;
  // 1º tempo: a partir dos 30'
  if (status === '1H' && min >= 30) return true;
  // 2º tempo: a partir dos 70'
  if (status === '2H' && min >= 70) return true;
  return false;
}

function linhaGols(m) {
  const h   = m.score_home;
  const a   = m.score_away;
  const fav = m.favorito;

  if (h === 0 && a === 0) return ['Over 1.5', 'Over 2.5'];
  if (h === 1 && a === 1) return ['Over 2.5', 'Over 3.5'];
  // Favorito perdendo 0x1
  if (fav === 'home' && h === 0 && a === 1) return ['Over 2.5'];
  if (fav === 'away' && a === 0 && h === 1) return ['Over 2.5'];
  return ['Over 1.5'];
}

// ── Busca odds pré-jogo para um fixture ──────────────────────────────
async function fetchOdds(fixtureId) {
  // Cache válido?
  const cached = oddsCache[fixtureId];
  if (cached && Date.now() - cached.fetchedAt < ODDS_TTL) return cached;

  try {
    trackReq();
    // Bookmaker 8 = Bet365 (referência de mercado europeu)
    const res = await axios.get(
      `https://${API_HOST}/odds?fixture=${fixtureId}&bookmaker=8&bet=1`,
      { headers, timeout: 8000 }
    );
    const bets = res.data.response?.[0]?.bookmakers?.[0]?.bets?.[0]?.values || [];

    // Extrai odds 1X2
    const oddHome = parseFloat(bets.find(b => b.value === 'Home')?.odd) || null;
    const oddAway = parseFloat(bets.find(b => b.value === 'Away')?.odd) || null;

    let favorito = null;
    if (oddHome && oddAway) {
      favorito = oddHome <= oddAway ? 'home' : 'away';
    }

    const result = { odd_home: oddHome, odd_away: oddAway, favorito, fetchedAt: Date.now() };
    oddsCache[fixtureId] = result;
    return result;
  } catch {
    return { odd_home: null, odd_away: null, favorito: null, fetchedAt: Date.now() };
  }
}

// ── Fetch principal: jogos ao vivo + filtros da spec ─────────────────
async function fetchLiveData() {
  trackReq();

  const liveRes = await axios.get(
    `https://${API_HOST}/fixtures?live=all`,
    { headers, timeout: 8000 }
  );
  const fixtures = liveRes.data.response || [];

  // Monta lista básica
  const raw = fixtures.map(f => ({
    id:         f.fixture.id,
    league:     f.league.name,
    home:       f.teams.home.name,
    away:       f.teams.away.name,
    score_home: f.goals.home  ?? 0,
    score_away: f.goals.away  ?? 0,
    minute:     f.fixture.status.elapsed ?? 0,
    status:     f.fixture.status.short,
    stats:      null,
    favorito:   null,
    odd_home:   null,
    odd_away:   null,
    linhas:     [],
  }));

  // Aplica filtro de janela ANTES de buscar odds/stats (economiza req)
  const naJanela = raw.filter(m => janelaValida(m));

  // Busca odds pré-jogo para jogos na janela (máx 5 por ciclo)
  const semOdds = naJanela
    .filter(m => !oddsCache[m.id] || Date.now() - oddsCache[m.id].fetchedAt >= ODDS_TTL)
    .slice(0, 5);

  await Promise.allSettled(semOdds.map(m => fetchOdds(m.id)));

  // Injeta favorito e linhas em cada jogo
  for (const m of raw) {
    const od = oddsCache[m.id];
    if (od) {
      m.favorito = od.favorito;
      m.odd_home = od.odd_home;
      m.odd_away = od.odd_away;
    }
    m.linhas = linhaGols(m);
  }

  // Filtra pelos cenários válidos da spec
  const filtrados = raw.filter(m => janelaValida(m) && cenarioValido(m));

  // Busca estatísticas só para os filtrados (máx 5)
  const toStats = filtrados.slice(0, 5);
  const statsResults = await Promise.allSettled(
    toStats.map(m =>
      axios.get(`https://${API_HOST}/fixtures/statistics?fixture=${m.id}`,
        { headers, timeout: 8000 })
      .then(r => ({ id: m.id, data: r.data.response || [] }))
    )
  );
  trackReq();

  const statsMap = {};
  for (const r of statsResults) {
    if (r.status !== 'fulfilled') continue;
    const { id, data } = r.value;
    if (data.length < 2) continue;
    const get  = (arr, t) => parseInt(arr.find(s => s.type === t)?.value)   || 0;
    const getF = (arr, t) => parseFloat(arr.find(s => s.type === t)?.value) || 0;
    const h = data[0].statistics;
    const a = data[1].statistics;
    statsMap[id] = {
      shots_home:     get(h, 'Total Shots'),
      shots_away:     get(a, 'Total Shots'),
      shots_on_home:  get(h, 'Shots on Goal'),
      shots_on_away:  get(a, 'Shots on Goal'),
      dangerous_home: get(h, 'Dangerous Attacks'),
      dangerous_away: get(a, 'Dangerous Attacks'),
      corners_home:   get(h, 'Corner Kicks'),   // escanteios — spec
      corners_away:   get(a, 'Corner Kicks'),
      xg_home:        getF(h, 'expected_goals'),
      xg_away:        getF(a, 'expected_goals'),
    };
  }

  for (const m of filtrados) {
    if (statsMap[m.id]) m.stats = { ...statsMap[m.id], minute: m.minute };
  }

  return {
    // Todos os jogos ao vivo (para a lista geral)
    matches: raw,
    // Apenas os que passaram nos filtros da spec (para o painel de alertas)
    filtrados,
    total:       raw.length,
    filtrados_n: filtrados.length,
    reqToday:    reqCount,
  };
}

// ── Endpoint /api/live ────────────────────────────────────────────────
app.get('/api/live', async (req, res) => {
  try {
    const now      = Date.now();
    const cacheAge = now - liveCache.fetchedAt;

    if (liveCache.data && cacheAge < LIVE_TTL) {
      return res.json({ ok: true, cached: true,
        cacheAge: Math.round(cacheAge / 1000) + 's', ...liveCache.data });
    }
    if (liveCache.pending) {
      const result = await liveCache.pending;
      return res.json({ ok: true, cached: true, ...result });
    }

    liveCache.pending = fetchLiveData();
    const result      = await liveCache.pending;
    liveCache.pending  = null;
    liveCache.data     = result;
    liveCache.fetchedAt = Date.now();

    res.json({ ok: true, cached: false, ...result });

  } catch (err) {
    liveCache.pending = null;
    if (liveCache.data) {
      return res.json({ ok: true, cached: true, stale: true, ...liveCache.data });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Status ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:      '⚡ Alerta de Sinais de Gol — backend online',
    versao:      '2.0 — spec atualizada',
    cacheTTL:    `${LIVE_TTL / 1000}s`,
    reqHoje:     reqCount,
    restantes:   Math.max(0, 100 - reqCount),
    filtros:     {
      cenarios:  '0x0 | favorito perdendo 0x1 | 1x1',
      janelas:   '1º tempo ≥ 30\' | 2º tempo ≥ 70\'',
      favorito:  'menor odd pré-jogo 1X2 (Bet365)',
    },
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ ASG backend v2.0 rodando na porta ${PORT}`);
});
