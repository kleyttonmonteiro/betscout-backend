// src/services/scoringService.js
// Motor de pontuação própria do Sinais de Gol / Alerta de Gol.
// Calcula probabilidade, veredito e odd mínima direto das estatísticas
// ao vivo, sem depender de IA externa (Anthropic/Gemini).
//
// Uso recomendado: chamar isso PRIMEIRO no POST /api/analyze.
// Só cair para a IA externa quando o score ficar na "faixa duvidosa"
// (ver FAIXA_DUVIDOSA no final do arquivo) — assim você reduz o consumo
// de créditos/cota drasticamente, mantendo a IA como reforço, não regra.
//
// ATUALIZAÇÃO (Fase 3 — novo contrato de resposta): além de veredito,
// probabilidade, risco, odd mínima e justificativa, agora também calcula:
// - janela: por quanto tempo esse sinal ainda vale a pena ser considerado
// - gatilho: qual foi o principal fator estatístico que disparou o sinal
// - invalidacao: em que situação o sinal deve ser descartado

// ===== PESOS (ajustáveis conforme você calibrar com o histórico real) =====
const PESOS = {
  chutesGol: 0.35,        // chutes no gol dos dois times somados
  ataquesPerigosos: 0.25, // pressão (AP1 + AP2)
  escanteios: 0.15,
  xg: 0.25,
};

// ===== VALORES DE REFERÊNCIA (usados para normalizar cada métrica em 0-100) =====
const REFERENCIA = {
  chutesGolMax: 8,          // 8 chutes no gol somados = teto (100%)
  ataquesPerigososMax: 100, // 100 ataques perigosos somados = teto
  escanteiosMax: 8,
  xgMax: 2.0,
};

// Bônus por cenário: favorito perdendo tende a pressionar mais pra empatar
const BONUS_CENARIO = {
  favorito_perdendo: 8,
  '1x1': 3,
  '0x0': 0,
};

function normalizar(valor, max) {
  return Math.min(valor / max, 1) * 100;
}

function calcularScore(stats) {
  const chutesGolTotal = (stats.chutesGolCasa || 0) + (stats.chutesGolFora || 0);
  const apTotal = (stats.ataquesPerigososCasa || 0) + (stats.ataquesPerigososFora || 0);
  const escanteiosTotal = (stats.escanteiosCasa || 0) + (stats.escanteiosFora || 0);
  const xgTotal = (stats.xgCasa || 0) + (stats.xgFora || 0);

  const scoreChutes = normalizar(chutesGolTotal, REFERENCIA.chutesGolMax) * PESOS.chutesGol;
  const scoreAP = normalizar(apTotal, REFERENCIA.ataquesPerigososMax) * PESOS.ataquesPerigosos;
  const scoreEscanteios = normalizar(escanteiosTotal, REFERENCIA.escanteiosMax) * PESOS.escanteios;
  const scoreXg = normalizar(xgTotal, REFERENCIA.xgMax) * PESOS.xg;

  const scoreBase = scoreChutes + scoreAP + scoreEscanteios + scoreXg;

  return {
    scoreBase: Math.round(scoreBase * 10) / 10,
    detalhes: {
      chutesGolTotal, apTotal, escanteiosTotal, xgTotal,
      scoreChutes, scoreAP, scoreEscanteios, scoreXg,
    },
  };
}

function ajustarPorContexto(scoreBase, contexto) {
  let score = scoreBase + (BONUS_CENARIO[contexto.cenario] || 0);

  // Pouco tempo restante + pressão baixa = probabilidade real menor
  const tempoRestante = 90 - (contexto.minuto || 45);
  if (tempoRestante < 15 && scoreBase < 55) {
    score -= 10;
  }

  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

function classificar(scoreFinal) {
  if (scoreFinal >= 70) {
    return { veredito: 'ENTRAR', nivel_risco: 'baixo', probabilidade: Math.min(80, 50 + scoreFinal * 0.4) };
  }
  if (scoreFinal >= 50) {
    return { veredito: 'AGUARDAR', nivel_risco: 'médio', probabilidade: 40 + scoreFinal * 0.3 };
  }
  return { veredito: 'EVITAR', nivel_risco: 'alto', probabilidade: Math.max(15, scoreFinal * 0.5) };
}

function calcularOddMinima(probabilidade) {
  const oddJusta = 100 / probabilidade;
  const margemSeguranca = 1.08; // 8% de margem sobre a odd justa
  return Math.round(oddJusta * margemSeguranca * 100) / 100;
}

function gerarJustificativa(detalhes, contexto, veredito) {
  const partes = [];
  if (detalhes.chutesGolTotal >= 4) partes.push(`${detalhes.chutesGolTotal} chutes no gol somados`);
  if (detalhes.apTotal >= 60) partes.push(`pressão alta (${detalhes.apTotal} ataques perigosos)`);
  if (detalhes.escanteiosTotal >= 5) partes.push(`${detalhes.escanteiosTotal} escanteios`);
  if (detalhes.xgTotal >= 1) partes.push(`xG combinado de ${detalhes.xgTotal.toFixed(2)}`);

  const base = partes.length > 0 ? partes.join(', ') : 'poucos indicadores de pressão até agora';

  if (veredito === 'ENTRAR') {
    return `Jogo mostra ${base}. Cenário (${contexto.cenario}) favorece o mercado ${contexto.linhaAlvo}.`;
  }
  if (veredito === 'AGUARDAR') {
    return `Indicadores mistos: ${base}. Vale observar mais alguns minutos antes de decidir.`;
  }
  return `Poucos sinais de pressão (${base}). Cenário não sustenta o mercado ${contexto.linhaAlvo} no momento.`;
}

// Identifica qual foi o principal fator (o de maior peso já normalizado)
// que puxou o score pra cima — é isso que vira o "gatilho" do sinal.
function gerarGatilho(detalhes, contexto) {
  const contribuicoes = [
    { nome: `Chutes no gol (${detalhes.chutesGolTotal} somados)`, peso: detalhes.scoreChutes },
    { nome: `Ataques perigosos (${detalhes.apTotal} somados)`, peso: detalhes.scoreAP },
    { nome: `Escanteios (${detalhes.escanteiosTotal} somados)`, peso: detalhes.scoreEscanteios },
    { nome: `xG combinado (${detalhes.xgTotal.toFixed(2)})`, peso: detalhes.scoreXg },
  ];
  contribuicoes.sort((a, b) => b.peso - a.peso);
  const principal = contribuicoes[0];
  if (principal.peso <= 0) return `Cenário ${contexto.cenario}, mas sem pressão estatística clara ainda`;
  return `${principal.nome} + cenário ${contexto.cenario}`;
}

// Por quanto tempo esse sinal ainda faz sentido ser considerado.
// Sinais fortes (score alto) valem uma janela um pouco mais larga.
function calcularJanela(contexto, scoreFinal) {
  const minuto = contexto.minuto || 45;
  const largura = scoreFinal >= 70 ? 10 : 7;
  const fim = Math.min(90, minuto + largura);
  if (fim - minuto <= 3) return `Até o fim do jogo (${minuto}'–90')`;
  return `Próximos ${fim - minuto} minutos (${minuto}'–${fim}')`;
}

// Em que situação esse sinal deve ser considerado "furado" e descartado.
function gerarInvalidacao(veredito, contexto) {
  if (veredito === 'ENTRAR') {
    return `Perde valor se o jogo ficar uns 10 minutos seguidos sem nenhuma finalização, ou se o placar sair do cenário ${contexto.cenario}.`;
  }
  if (veredito === 'AGUARDAR') {
    return `Descarte se a pressão cair (menos finalizações/ataques) nos próximos minutos, ou se o placar sair do cenário ${contexto.cenario}.`;
  }
  return `Só reconsidere se a pressão aumentar bastante nos próximos minutos.`;
}

/**
 * Função principal: calcula a análise sem chamar nenhuma IA externa.
 * @param {object} stats - { chutesGolCasa, chutesGolFora, ataquesPerigososCasa,
 *   ataquesPerigososFora, escanteiosCasa, escanteiosFora, xgCasa, xgFora }
 * @param {object} contexto - { cenario, linhaAlvo, minuto }
 */
function calcularAnalise(stats, contexto) {
  const { scoreBase, detalhes } = calcularScore(stats);
  const scoreFinal = ajustarPorContexto(scoreBase, contexto);
  const { veredito, nivel_risco, probabilidade } = classificar(scoreFinal);
  const probabilidadeArredondada = Math.round(probabilidade);

  return {
    veredito,
    probabilidade: probabilidadeArredondada,
    nivel_risco,
    sugestao_odd_minima: calcularOddMinima(probabilidadeArredondada),
    linha_sugerida: contexto.linhaAlvo,
    justificativa: gerarJustificativa(detalhes, contexto, veredito),
    janela: calcularJanela(contexto, scoreFinal),
    gatilho: gerarGatilho(detalhes, contexto),
    invalidacao: gerarInvalidacao(veredito, contexto),
    score_interno: scoreFinal,
    fonte: 'motor_proprio', // diferencia no log/histórico: motor_proprio vs anthropic vs gemini
  };
}

// Faixa em que o score não é claro o suficiente — só aqui vale chamar a IA externa
const FAIXA_DUVIDOSA = { min: 45, max: 65 };

function precisaDeIA(scoreFinal) {
  return scoreFinal >= FAIXA_DUVIDOSA.min && scoreFinal <= FAIXA_DUVIDOSA.max;
}

module.exports = { calcularAnalise, calcularScore, precisaDeIA, FAIXA_DUVIDOSA };
