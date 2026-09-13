import { CONFIG } from '../config.js';
import { markets, isStable } from '../api/market.js';
import { analyzeCoin, analystContext, llmData, detectSymbol, portfolioSummary, scanMarket, marketContext, scanMarketMulti, marketContextMulti } from '../ai/context.js';
import { ruleBasedAnswer, isMarketWide } from '../lib/analyst.js';
import { aiState, deviceSupport, loadLocalModel, askLLM, localReady, customReady, recommendedModelId } from '../ai/engine.js';
import { $, $$, icon, markdown, bindSeg, toast } from '../ui.js';
import { esc, price, changeHtml, money} from '../format.js';
import { settings } from '../store.js';

export const title = 'Assistant';
const history = []; // survives navigation within the session

export async function render(el, [symParam]) {
  const all = await markets().catch(() => []);
  const st = { symbol: (symParam || history.lastSymbol || 'BTC').toUpperCase(), interval: '4h', busy: false, abort: null, disposed: false };
  const support = await deviceSupport();
  const s = settings.get();

  el.innerHTML = `
    <div class="page-head"><div><h1>Assistant</h1><p>Ask about any coin — answers use live prices, signals, backtests and the AI forecast. Runs on your device; no account or API key.</p></div></div>
    <div class="chat">
      <div class="card chat-box">
        <div class="chat-log" id="log" aria-live="polite"></div>
        <div class="suggest" id="suggest"></div>
        <form class="chat-input" id="form">
          <textarea class="inp" id="q" rows="1" placeholder="e.g. Will ${esc(st.symbol)} go up tomorrow? When should I sell?" aria-label="Your question"></textarea>
          <button class="btn primary" id="send" aria-label="Send">${icon('send', 16)}</button>
        </form>
      </div>
      <div class="stack">
        <div class="card" id="engineCard"></div>
        <div class="card">
          <div class="card-h"><h3>Coin in focus</h3></div>
          <div class="row" style="margin-bottom:10px">
            <select class="inp" id="coinSel" style="flex:1">${all.filter((c) => c.binance && !isStable(c.symbol)).slice(0, 150).map((c) => `<option value="${esc(c.symbol)}" ${c.symbol === st.symbol ? 'selected' : ''}>${esc(c.symbol)} · ${esc(c.name)}</option>`).join('')}</select>
          </div>
          <div class="row"><span class="fine">Chart</span><div class="seg" id="ivSeg">${['1m', '5m', '15m', '1h', '4h', '1d'].map((iv) => `<button data-v="${iv}" class="${iv === st.interval ? 'on' : ''}">${iv}</button>`).join('')}</div></div>
          <div id="focus" class="mt fine"></div>
        </div>
        <div class="card fine">
          <b>How the assistant works</b>
          <ol style="padding-left:18px;margin:6px 0 0">
            <li>Pulls live candles from Binance for the coin you ask about.</li>
            <li>Computes signals on 4 timeframes, a backtest, and the AI forecast (7 models incl. pattern matching, neural network and boosted trees — accuracy-checked).</li>
            <li>The built-in language model turns those verified numbers into a plain-English answer.</li>
          </ol>
          <p class="mt">Not financial advice. The assistant cannot place trades.</p>
        </div>
      </div>
    </div>`;

  const log = $('#log', el);
  const drawFocus = () => {
    const c = all.find((x) => x.symbol === st.symbol);
    $('#focus', el).innerHTML = c ? `<div class="row spread"><a class="acc" href="#/coin/${esc(c.symbol)}">${esc(c.name)} chart →</a><span><b>${money(c.price)}</b> ${changeHtml(c.change24h)}</span></div>` : '';
    const sym = st.symbol;
    $('#suggest', el).innerHTML = [
      'Which coin should I buy right now?', 'Best buys for each timeframe, and when do I sell?',
      'What should I hold for weeks, and what is only a quick trade?',
      `Will ${sym} go up or down next?`, `When should I take profit on ${sym}?`,
      `I have $1,000 — how much ${sym} should I buy?`, 'Review my portfolio',
    ].map((q) => `<button class="btn sm" type="button">${esc(q)}</button>`).join('');
    $$('#suggest button', el).forEach((b) => b.addEventListener('click', () => ask(b.textContent)));
  };

  // ------------------------------------------------------------ engine card
  const drawEngine = () => {
    const card = $('#engineCard', el);
    const status = aiState.status;
    const opts = CONFIG.LLM_MODELS.map((m) => `<option value="${m.id}" ${(s.llmModel || '').startsWith(m.id.split('-q4')[0]) ? 'selected' : ''}>${m.label} · ${m.size}</option>`).join('');
    let body;
    if (customReady()) {
      body = `<p><span class="chip up">● Connected</span> Using your AI endpoint <b>${esc(settings.get().customModel || '')}</b>.</p>`;
    } else if (status === 'ready') {
      body = `<p><span class="chip up">● Running on this device</span></p><p class="fine">${esc(aiState.model)} · private, free, works offline once downloaded.</p>`;
    } else if (status === 'loading') {
      body = `<p class="row"><span class="spinner"></span><b>Starting built-in AI…</b></p><div class="meter"><i style="width:${Math.round(aiState.progress * 100)}%"></i></div><p class="fine mt">${esc(aiState.text.slice(0, 140))}</p><p class="fine">First start downloads the model once; after that it loads from cache in seconds.</p>`;
    } else if (!support.webgpu) {
      body = `<p><span class="chip warn">Instant analyst mode</span></p><p class="fine">This browser has no WebGPU, so the language model can't run here. You still get full answers from the rule-based analyst. For the LLM, use Chrome, Edge or Safari 26+ on a computer or recent phone.</p>`;
    } else {
      body = `<p class="fine">Download a free AI model that runs <b>inside your browser</b> (WebGPU). Nothing is sent to any server.</p>
        <label class="fld mt">Model<select class="inp" id="modelSel">${opts}</select></label>
        <button class="btn primary mt" id="startAi" style="width:100%">${icon('chip', 16)} Start built-in AI</button>
        ${status === 'error' ? `<p class="fine down mt">${esc(aiState.text)}</p>` : ''}
        <p class="fine mt">Until then, answers come instantly from the rule-based analyst.</p>`;
    }
    card.innerHTML = `<div class="card-h"><h3>${icon('ai', 16)} Built-in AI</h3></div>${body}
      <details class="mt"><summary class="fine" style="cursor:pointer">Advanced: use your own AI server</summary>
        <form id="customForm" class="stack mt" style="gap:8px">
          <label class="fld">OpenAI-compatible URL<input class="inp" name="url" placeholder="http://localhost:11434/v1" value="${esc(settings.get().customEndpoint)}"></label>
          <label class="fld">Model name<input class="inp" name="model" placeholder="llama3.1" value="${esc(settings.get().customModel)}"></label>
          <label class="fld">API key (optional)<input class="inp" name="key" type="password" value="${esc(settings.get().customKey)}"></label>
          <div class="row"><button class="btn sm primary">Save</button><button class="btn sm" type="button" id="clearCustom">Remove</button></div>
          <p class="fine">Works with Ollama, LM Studio, vLLM or any OpenAI-compatible service. The key stays in this browser.</p>
        </form></details>`;
    $('#startAi', card)?.addEventListener('click', async () => {
      try { await loadLocalModel($('#modelSel', card).value); toast('Built-in AI is ready', 'up'); }
      catch (e) { toast(e.message, 'down'); }
    });
    $('#customForm', card).addEventListener('submit', (e) => {
      e.preventDefault();
      settings.set({ customEndpoint: e.target.url.value.trim(), customModel: e.target.model.value.trim(), customKey: e.target.key.value.trim() });
      toast('AI endpoint saved', 'up'); drawEngine();
    });
    $('#clearCustom', card).addEventListener('click', () => { settings.set({ customEndpoint: '', customModel: '', customKey: '' }); drawEngine(); });
  };
  const onAi = () => { if (!st.disposed) drawEngine(); };
  aiState.addEventListener('change', onAi);

  // ------------------------------------------------------------ messages
  const addMsg = (role, html) => {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.innerHTML = html;
    log.append(div);
    log.scrollTop = log.scrollHeight;
    return div;
  };
  const drawHistory = () => {
    log.innerHTML = '';
    if (!history.length) {
      addMsg('bot', markdown(`Hi! I'm the **${CONFIG.APP_NAME} AI**. Ask me about the **whole market** — *"Which coin should I buy, for how long, and when do I sell?"* — and I'll rank every coin on the short-term, swing and position timeframes. Or ask about one coin: *"Will ETH go up this week?"*, *"When should I sell SOL?"*, *"Review my portfolio"*.\n\nI check live data, signals on 4 timeframes, a backtest and a machine-learning forecast before answering.`));
    }
    for (const m of history) addMsg(m.role === 'user' ? 'user' : 'bot', m.role === 'user' ? esc(m.content) : markdown(m.content) + (m.meta ? `<div class="src">${m.meta}</div>` : ''));
  };

  async function ask(question) {
    question = question.trim();
    if (!question || st.busy) return;
    st.busy = true;
    $('#send', el).disabled = true;
    history.push({ role: 'user', content: question });
    addMsg('user', esc(question));
    const bot = addMsg('bot', '<span class="typing"><i></i><i></i><i></i></span> <span class="fine" data-step>Thinking…</span>');
    const step = (t) => { const n = bot.querySelector('[data-step]'); if (n) n.textContent = t; };
    try {
      const wantsPortfolio = /(portfolio|wallet|holding|my coins)/i.test(question);
      const detected = await detectSymbol(question);
      // "Which coin should I buy?" is about the whole market — only treat it as
      // a single-coin question when the user actually named a coin.
      const wantsMarket = isMarketWide(question) && !detected;
      if (detected && detected !== st.symbol) { st.symbol = detected; $('#coinSel', el).value = detected; drawFocus(); }
      history.lastSymbol = st.symbol;
      const portfolio = await portfolioSummary();

      let analysis = null, market = null, marketFrames = null;
      if (wantsMarket) {
        step('Scanning every coin on 3 timeframes…');
        const byInterval = await scanMarketMulti({ count: 20, onStep: step });
        marketFrames = marketContextMulti(byInterval);
        market = marketFrames.frames.find((f) => f.interval === st.interval) || marketFrames.frames[1] || marketFrames.frames[0] || null;
      } else if (!wantsPortfolio || detected) {
        analysis = await analyzeCoin(st.symbol, { interval: st.interval, onStep: step });
      }
      const ctx = analysis ? { ...analystContext(analysis, portfolio), market, marketFrames } : { portfolio, market, marketFrames };
      const facts = ruleBasedAnswer(question, ctx);
      const meta = (src) => `<span>${esc(src)}</span>${marketFrames ? `<span>· scanned ${marketFrames.scanned} coins on ${esc(marketFrames.intervals.join(', '))}</span>` : market ? `<span>· scanned ${market.scanned} coins on ${esc(market.interval)}</span>` : ''}${analysis ? `<span>· ${esc(analysis.coin.symbol)} ${esc(analysis.interval)} · ${analysis.source === 'binance' ? 'live Binance data' : analysis.source === 'demo' ? 'demo data' : 'CoinGecko data'}</span>` : ''}<a href="#" data-facts>· show data used</a>`;
      let finalText = facts, source = 'Rule-based analyst (instant)';
      if (localReady() || customReady()) {
        step('Writing answer…');
        const ac = new AbortController(); st.abort = ac;
        try {
          const data = analysis ? llmData(analysis) : {};
          if (marketFrames) data.marketByTimeframe = marketFrames;
          else if (market) data.marketPicks = market;
          if (portfolio.length) data.portfolio = portfolio.map((p) => ({ coin: p.symbol, valueUsd: Math.round(p.value), pnlPct: p.pnlPct !== null ? +p.pnlPct.toFixed(1) : null }));
          const r = await askLLM({ history: history.slice(0, -1), question, facts, data, signal: ac.signal, onText: (t) => { bot.innerHTML = markdown(t); log.scrollTop = log.scrollHeight; } });
          if (r.text.trim().length > 20) { finalText = r.text; source = `${r.source} · built-in AI`; }
        } catch (err) {
          console.warn('LLM failed, using analyst', err);
          source = 'Rule-based analyst (AI model unavailable)';
        }
      }
      history.push({ role: 'assistant', content: finalText, meta: meta(source) });
      bot.innerHTML = markdown(finalText) + `<div class="src">${meta(source)}</div>`;
      bot.querySelector('[data-facts]')?.addEventListener('click', (e) => { e.preventDefault(); addMsg('bot', `<div class="fine"><b>Verified data behind this answer</b></div>${markdown(facts)}`); });
    } catch (err) {
      bot.innerHTML = markdown(`Sorry — ${err.message}`);
      history.push({ role: 'assistant', content: `Sorry — ${err.message}` });
    } finally {
      st.busy = false; st.abort = null;
      if (!st.disposed) $('#send', el).disabled = false;
      log.scrollTop = log.scrollHeight;
    }
  }

  $('#form', el).addEventListener('submit', (e) => { e.preventDefault(); const q = $('#q', el); ask(q.value); q.value = ''; });
  $('#q', el).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form', el).requestSubmit(); } });
  $('#coinSel', el).addEventListener('change', (e) => { st.symbol = e.target.value; history.lastSymbol = st.symbol; drawFocus(); });
  bindSeg($('#ivSeg', el), (v) => { st.interval = v; });

  drawHistory(); drawFocus(); drawEngine();

  // Auto-start the local model if this browser already downloaded it before
  if (support.webgpu && s.llmAuto && s.llmModel && aiState.status === 'idle') {
    loadLocalModel(s.llmModel).catch(() => {});
  }
  if (!support.webgpu && !s.llmModel) recommendedModelId();
  return () => { st.disposed = true; st.abort?.abort(); aiState.removeEventListener('change', onAi); };
}
