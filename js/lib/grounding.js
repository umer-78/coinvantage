// Figures a language model wrote that are not in the verified data it was
// given. Small local models rephrase well but now and then invent a price or
// a percentage, and in a trading tool an invented stop-loss is worse than no
// answer. Only figures that matter are checked: prices, percentages, amounts
// and anything with decimals. Counts such as "3 coins" or "the 4h chart" are not.

const NUM = /([$€£¥₨]\s?)?(\d+(?:,\d{3})*(?:\.\d+)?)(\s?(?:%|[kKmMbB]\b))?/g;
const SCALE = { k: 1e3, m: 1e6, b: 1e9 };
// Indicator settings a model may name without them appearing in the data.
const COMMON = [100, 200];

function figures(text) {
  const out = [];
  const t = String(text ?? '')
    .replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, ' ') // dates
    .replace(/\b\d{1,2}:\d{2}\b/g, ' '); // times
  for (const m of t.matchAll(NUM)) {
    const [raw, cur, num, suffix = ''] = m;
    if (/[A-Za-z_]/.test(t[m.index - 1] || '')) continue; // part of a word: EMA200, Qwen3
    const unit = suffix.trim().toLowerCase();
    const scale = SCALE[unit] || 1;
    const [whole, dec = ''] = num.replace(/,/g, '').split('.');
    const value = Number(`${whole}.${dec || 0}`) * scale;
    if (!Number.isFinite(value)) continue;
    // what the written precision allows: 77,400 may be 77,370 rounded
    const zeros = dec ? 0 : (whole.match(/0+$/)?.[0].length || 0);
    const step = (dec ? 10 ** -dec.length : 10 ** Math.min(zeros, Math.max(0, whole.length - 1))) * scale;
    const material = Boolean(cur) || unit === '%' || unit in SCALE || Boolean(dec) || value >= 100;
    out.push({ raw: raw.trim(), value, tol: step / 2, material });
  }
  return out;
}

/**
 * The material figures in `answer` that match nothing in `sources` (the
 * verified answer, the data, the question), allowing for rounding and for a
 * probability written as a percentage. Returns the figures as written.
 */
export function unsupportedFigures(answer, sources) {
  const known = [...COMMON];
  for (const f of figures(sources.join('\n'))) {
    known.push(f.value);
    if (f.value <= 1) known.push(f.value * 100);
  }
  const bad = [];
  for (const f of figures(answer)) {
    if (!f.material) continue;
    const slack = Math.max(f.tol, f.value * 0.002) + 1e-9;
    if (!known.some((k) => Math.abs(k - f.value) <= slack) && !bad.includes(f.raw)) bad.push(f.raw);
  }
  return bad;
}

/** How many material figures `answer` has. */
export const materialFigures = (answer) => figures(answer).filter((f) => f.material).length;
