// Long-range history tools: "when this coin's chart looked like this before, what happened next?"
// Works on daily candles so it can look back over years (previous cycles, past bear markets).
// Everything here is measured, not assumed: the analog method reports its own hit rate.

const logs = (candles) => candles.map((c) => Math.log(c.c));

function znorm(arr) {
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length) || 1;
  return arr.map((v) => (v - m) / sd);
}

/**
 * Find the past windows whose shape is closest to the window ending at `endIdx`
 * and report what price did over several horizons afterwards.
 */
export function findAnalogs(daily, endIdx = daily.length - 1, { window = 45, horizons = [7, 30, 90], topK = 8, minCorr = 0.7, minGap = null } = {}) {
  const W = window;
  const maxH = Math.max(...horizons);
  const L = logs(daily);
  const raw = daily.map((c) => c.c);
  if (endIdx - W < W + maxH + 5) return { ok: false, reason: 'Not enough daily history for long-range comparison.' };
  const cur = znorm(L.slice(endIdx - W + 1, endIdx + 1));
  const gap = minGap ?? Math.floor(W / 2);
  const cands = [];
  for (let s = 0; s + W - 1 + maxH <= endIdx - W; s++) {
    const seg = L.slice(s, s + W);
    const z = znorm(seg);
    let corr = 0;
    for (let j = 0; j < W; j++) corr += z[j] * cur[j];
    corr /= W;
    if (corr >= minCorr) cands.push({ s, corr });
  }
  cands.sort((a, b) => b.corr - a.corr);
  const picked = [];
  for (const c of cands) {
    if (picked.every((p) => Math.abs(p.s - c.s) >= gap)) picked.push(c);
    if (picked.length >= topK) break;
  }
  if (!picked.length) return { ok: false, reason: 'No similar chart shapes found in this coin\'s history yet.' };

  const matches = picked.map(({ s, corr }) => {
    const e = s + W - 1;
    const outcomes = {};
    for (const h of horizons) outcomes[h] = (raw[e + h] / raw[e] - 1) * 100;
    let maxUp = 0, maxDown = 0;
    for (let h = 1; h <= maxH; h++) {
      const r = (raw[e + h] / raw[e] - 1) * 100;
      maxUp = Math.max(maxUp, r); maxDown = Math.min(maxDown, r);
    }
    return {
      startIndex: s, endIndex: e, startTime: daily[s].t, endTime: daily[e].t,
      similarity: corr, outcomes, maxUpPct: maxUp, maxDownPct: maxDown,
      series: raw.slice(s, e + maxH + 1).map((p) => (p / raw[e]) * 100),
    };
  });

  const weights = matches.map((m) => m.similarity ** 4);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const stats = {};
  for (const h of horizons) {
    const vals = matches.map((m) => m.outcomes[h]);
    const sorted = [...vals].sort((a, b) => a - b);
    stats[h] = {
      probUp: matches.reduce((acc, m, i) => acc + (m.outcomes[h] > 0 ? weights[i] : 0), 0) / wsum,
      upCount: vals.filter((v) => v > 0).length,
      total: vals.length,
      median: sorted[Math.floor(sorted.length / 2)],
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      best: Math.max(...vals),
      worst: Math.min(...vals),
    };
  }
  return {
    ok: true, window: W, horizons, matches, stats,
    current: raw.slice(endIdx - W + 1, endIdx + 1).map((p) => (p / raw[endIdx]) * 100),
    avgSimilarity: matches.reduce((a, m) => a + m.similarity, 0) / matches.length,
  };
}

/** Honest hit rate of the analog method on this coin: walk forward through history. */
export function validateAnalogs(daily, { window = 45, horizon = 30, minCorr = 0.7, maxTests = 60 } = {}) {
  const raw = daily.map((c) => c.c);
  const first = Math.floor(daily.length * 0.45);
  const step = Math.max(horizon, Math.floor((daily.length - horizon - first) / maxTests));
  let hit = 0, n = 0, sumRet = 0;
  for (let i = first; i < daily.length - horizon; i += step) {
    const a = findAnalogs(daily, i, { window, horizons: [horizon], minCorr, topK: 8 });
    if (!a.ok) continue;
    const predictUp = a.stats[horizon].probUp >= 0.5;
    const actualUp = raw[i + horizon] > raw[i];
    n++; if (predictUp === actualUp) hit++;
    sumRet += (raw[i + horizon] / raw[i] - 1) * 100 * (predictUp ? 1 : -1);
  }
  return { tests: n, accuracy: n ? hit / n : null, avgDirectionalReturnPct: n ? sumRet / n : null, horizon, window };
}

/** Monthly seasonality: how this coin performed in each calendar month across the years. */
export function seasonality(daily) {
  const byMonthYear = new Map(); // `${y}-${m}` -> { first, last }
  for (const c of daily) {
    const d = new Date(c.t);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const e = byMonthYear.get(key);
    if (!e) byMonthYear.set(key, { first: c.c, last: c.c, y: d.getUTCFullYear(), m: d.getUTCMonth(), days: 1 });
    else { e.last = c.c; e.days++; }
  }
  const months = Array.from({ length: 12 }, () => []);
  const history = [];
  for (const e of byMonthYear.values()) {
    if (e.days < 20) continue; // skip partial months (including the current one)
    const ret = (e.last / e.first - 1) * 100;
    months[e.m].push({ year: e.y, ret });
    history.push({ year: e.y, month: e.m, ret });
  }
  const summary = months.map((rows, m) => {
    if (!rows.length) return { month: m, count: 0 };
    const vals = rows.map((r) => r.ret).sort((a, b) => a - b);
    return {
      month: m, count: rows.length,
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      median: vals[Math.floor(vals.length / 2)],
      winRate: (vals.filter((v) => v > 0).length / vals.length) * 100,
      years: rows.sort((a, b) => b.year - a.year),
    };
  });
  const now = new Date();
  return { summary, current: summary[now.getUTCMonth()], currentMonth: now.getUTCMonth(), history };
}

/** Year-by-year performance paths (day of year → % from 1 Jan), for the overlay chart. */
export function yearPaths(daily, maxYears = 5) {
  const byYear = new Map();
  for (const c of daily) {
    const d = new Date(c.t);
    const y = d.getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(c);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a).slice(0, maxYears);
  return years.map((y) => {
    const rows = byYear.get(y);
    const base = rows[0].c;
    const dayOf = (t) => Math.round((t - Date.UTC(y, 0, 1)) / 864e5);
    return {
      year: y,
      points: rows.map((c) => ({ x: dayOf(c.t), y: (c.c / base - 1) * 100 })),
      totalPct: (rows[rows.length - 1].c / base - 1) * 100,
      complete: rows.length > 300,
    };
  });
}

/** One plain-English verdict combining analogs, seasonality and the measured hit rate. */
export function historyVerdict(analogs, season, validation, horizon = 30) {
  if (!analogs?.ok) return null;
  const s = analogs.stats[horizon] || Object.values(analogs.stats)[0];
  const seasonBias = season?.current?.count ? season.current.avg : null;
  const probUp = s.probUp;
  const direction = probUp >= 0.6 ? 'UP' : probUp <= 0.4 ? 'DOWN' : 'MIXED';
  const reliable = validation?.accuracy !== null && validation?.tests >= 15;
  const parts = [];
  parts.push(`${s.upCount} of ${s.total} times when this chart looked like today, price was ${s.median >= 0 ? 'higher' : 'lower'} ${horizon} days later (median ${s.median >= 0 ? '+' : ''}${s.median.toFixed(1)}%).`);
  if (seasonBias !== null) parts.push(`Historically this month averaged ${seasonBias >= 0 ? '+' : ''}${seasonBias.toFixed(1)}% for this coin (${season.current.count} years, ${season.current.winRate.toFixed(0)}% positive).`);
  if (reliable) parts.push(`On this coin, the pattern method called the ${horizon}-day direction right ${(validation.accuracy * 100).toFixed(0)}% of the time across ${validation.tests} past tests.`);
  else parts.push('Too few past tests to judge how reliable this method is for this coin.');
  return {
    direction, probUp, horizon,
    medianPct: s.median, bestPct: s.best, worstPct: s.worst,
    seasonalAvgPct: seasonBias,
    accuracy: reliable ? validation.accuracy : null,
    text: parts.join(' '),
  };
}

/**
 * One call that does the whole long-range study: find analogs (relaxing the
 * similarity bar until something is found), measure how often that method was
 * right on this coin, add seasonality and the year-by-year paths.
 */
export function analyzeHistory(daily, { window = 45, horizons = [7, 30, 90], horizon = 30 } = {}) {
  if (!daily || daily.length < 200) return { ok: false, reason: 'Needs at least 200 days of history for a long-range comparison.' };
  let analogs = null, minCorr = 0.8;
  // Drop the similarity bar until matches appear. If even a loose bar finds
  // nothing, take the closest windows anyway and flag them as weak — saying
  // "the nearest thing to today only matched 40%" is more useful than silence.
  for (const level of [0.8, 0.7, 0.6, 0.5, -1]) {
    minCorr = level;
    analogs = findAnalogs(daily, daily.length - 1, { window, horizons, minCorr: level });
    if (analogs.ok) break;
  }
  const season = seasonality(daily);
  const years = yearPaths(daily, 6);
  if (!analogs.ok) return { ok: false, reason: analogs.reason, season, years, window, horizon };
  const weak = analogs.matches[0].similarity < 0.5;
  const validation = validateAnalogs(daily, { window, horizon, minCorr: Math.max(0, minCorr) });
  const verdict = historyVerdict(analogs, season, validation, horizon);
  if (weak) verdict.text += ' Note: nothing in this coin\'s history is a close match for today\'s chart, so this comparison is weak evidence.';
  const summary = summarizeHistory(analogs, season, validation, horizon);
  summary.matchQuality = weak ? 'weak' : 'good';
  return {
    ok: true, analogs, season, years, validation, verdict, summary, weak,
    window, horizon, horizons, minCorr: Math.max(0, minCorr),
    firstDate: daily[0].t, lastDate: daily[daily.length - 1].t, days: daily.length,
  };
}

/** Compact version for the AI assistant / LLM context. */
export function summarizeHistory(analogs, season, validation, horizon = 30) {
  const v = historyVerdict(analogs, season, validation, horizon);
  if (!v) return null;
  return {
    lookback: 'daily candles, full history',
    windowDays: analogs.window,
    horizonDays: horizon,
    similarPastCases: analogs.matches.length,
    wentUpAfter: `${analogs.stats[horizon]?.upCount}/${analogs.stats[horizon]?.total}`,
    medianMovePct: +v.medianPct.toFixed(2),
    bestCasePct: +v.bestPct.toFixed(1),
    worstCasePct: +v.worstPct.toFixed(1),
    methodAccuracyPct: v.accuracy !== null ? +(v.accuracy * 100).toFixed(1) : null,
    thisMonthHistoricalAvgPct: v.seasonalAvgPct === null ? null : +v.seasonalAvgPct.toFixed(2),
    // The anchor date is the day the past chart matched today's, not the start
    // of the window — that is the date the "and then…" outcome is measured from.
    examples: analogs.matches.slice(0, 4).map((m) => ({
      date: new Date(m.endTime).toISOString().slice(0, 10),
      similarityPct: +(m.similarity * 100).toFixed(0),
      thenMovedPct: +m.outcomes[horizon].toFixed(1),
    })),
    verdict: v.direction,
  };
}
