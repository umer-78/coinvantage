// The language model's prompt fits its window, a refused long prompt is
// retried shorter, and figures it was not given are caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, buildMessages, askLLM, CONTEXT_TOKENS, ANSWER_TOKENS } from '../js/ai/engine.js';
import { unsupportedFigures, materialFigures } from '../js/lib/grounding.js';
import { settings } from '../js/store.js';

const total = (msgs) => msgs.reduce((a, m) => a + estimateTokens(m.content) + 8, 0);

test('token estimate errs high against the real tokenizers', () => {
  // counted with the Qwen3 and Llama 3.2 tokenizers on 12 Oct 2026 (larger of the two)
  const measured = [
    ['{"coin":"Bitcoin (BTC)","price":77370.42,"change24hPct":-1.84,"chart":"4h","signal":{"verdict":"Leans up","score":18,"plan":{"side":"long","entryZone":[76950.1,77370.42],"stopLoss":74120.5,"takeProfits":[80100.25,82950.75]},"rsi":54.3}}', 117],
    ['**Leans up, low conviction.** The 4h chart is mildly positive, but the forecast has been right only 53.9% of the time on this timeframe, so treat it as weak evidence.\n- Entry: $76,950 – $77,370\n- Stop-loss: $74,120 (−4.2%)\n- Targets: $80,100 then $82,950\nNot financial advice.', 105],
    ['کیا بٹ کوائن اگلے ہفتے اوپر جائے گا؟', 27],
  ];
  for (const [s, n] of measured) {
    const e = estimateTokens(s);
    assert.ok(e >= n && e <= n * 1.9, `${e} for ${n} real tokens`);
  }
});

const bigScan = { marketByTimeframe: { frames: Array.from({ length: 3 }, (_, f) => ({ interval: ['1h', '4h', '1d'][f], buys: Array.from({ length: 20 }, (_, i) => ({ coin: `C${i}`, entry: [101.25 + i, 102.5 + i], stop: 97.125 + i, targets: [108.75 + i, 115.5 + i] })) })) } };

test('a long chat with a whole-market scan still fits the window with room for the answer', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}: ` + 'Price 77370.42 and RSI 54.3, '.repeat(120) }));
  const facts = ['**Verdict: wait.**', ...Array.from({ length: 200 }, (_, i) => `- line ${i}: stop 74120.5, target 80100.25`)].join('\n');
  const msgs = buildMessages(history, 'What should I buy right now?', facts, bigScan);
  assert.ok(total(msgs) <= CONTEXT_TOKENS - ANSWER_TOKENS, `${total(msgs)} estimated tokens`);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user', 'the chat starts with a user turn');
  const last = msgs.at(-1).content;
  assert.match(last, /^FACTS \(verified analysis\):\n\*\*Verdict: wait\.\*\*/, 'the verdict line stays');
  assert.match(last, /QUESTION: What should I buy right now\?$/);
  const json = JSON.parse(last.split('DATA (JSON):\n')[1].split('\n\nQUESTION')[0]);
  assert.equal(json.marketByTimeframe.frames.length, 3, 'shortened, still valid, every timeframe kept');
  // a smaller window gives a smaller prompt
  assert.ok(total(buildMessages(history, 'q', facts, bigScan, { context: 2400 })) <= 2400 - ANSWER_TOKENS);
});

test('a short chat goes through whole', () => {
  const history = [{ role: 'user', content: 'Will BTC go up?' }, { role: 'assistant', content: '**Leans up.** Not financial advice.' }];
  const msgs = buildMessages(history, 'Why?', 'BTC leans up.', { coin: 'Bitcoin (BTC)', price: 77370.42 });
  assert.deepEqual(msgs.slice(1, 3), history);
  assert.equal(msgs.at(-1).content, 'FACTS (verified analysis):\nBTC leans up.\n\nDATA (JSON):\n{"coin":"Bitcoin (BTC)","price":77370.42}\n\nQUESTION: Why?');
});

test('a prompt your server refuses as too long is sent again, shorter', async () => {
  globalThis.window ??= new EventTarget(); // settings announce their changes
  settings.set({ customEndpoint: 'http://127.0.0.1:1/v1', customModel: 'test-model' });
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push(opts.body.length);
    if (sent.length === 1) return new Response('{"error":"This model\'s maximum context length is 2048 tokens"}', { status: 400 });
    const sse = ['Hello, this is a test answer from the server.', ''].map((c, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: i ? 'length' : null }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const facts = Array.from({ length: 300 }, (_, i) => `- fact ${i}: 77370.42`).join('\n');
    const r = await askLLM({ history: [], question: 'Will BTC go up?', facts, data: bigScan });
    assert.equal(sent.length, 2);
    assert.ok(sent[1] < sent[0], `second prompt ${sent[1]} < first ${sent[0]}`);
    assert.equal(r.text, 'Hello, this is a test answer from the server.');
    assert.equal(r.where, 'endpoint');
    assert.equal(r.cut, true, 'stopped at the length limit');
  } finally {
    globalThis.fetch = realFetch;
    settings.set({ customEndpoint: '', customModel: '' });
  }
});

test('figures the model was not given are caught; rounding and percentages are not', () => {
  const facts = 'BTC at $77,370.42, RSI 54.3, stop 74,120.5, targets 80,100 and 82,950. Forecast 62% up, right 53.9% of the time. 2026-10-12 14:00 on the 4h chart. Risk 1-2% a trade.';
  const data = JSON.stringify({ price: 77370.42, probUp: 0.62 });
  const ok = 'BTC is at $77,370 (RSI 54). Stop 74,120; targets $80.1k and 82,950. Up 62%, right 54% of the time; risk 1-2%. Watch the 200 EMA and EMA200 on the 4h chart, 3 coins, 12 hours.';
  assert.deepEqual(unsupportedFigures(ok, [facts, data]), []);
  assert.equal(materialFigures(ok), 8);
  assert.deepEqual(unsupportedFigures('Buy at $77,400, sell at $79,000, stop 75,500: up 4.5% in 3 days.', [facts, data]), ['$79,000', '75,500', '4.5%']);
  assert.deepEqual(unsupportedFigures('Released 2026-10-12 at 14:00.', [facts]), [], 'dates and times are not figures');
});
