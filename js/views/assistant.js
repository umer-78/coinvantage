import { CONFIG } from '../config.js';
import { markets, isStable } from '../api/market.js';
import { live } from '../api/live.js';
import { analyzeCoin, analystContext, llmData, detectSymbol, portfolioSummary, scanMarket, marketContext, scanMarketMulti, marketContextMulti, compareCoins } from '../ai/context.js';
import { ruleBasedAnswer, isMarketWide, detectCompare, namedCoins, horizonChart, SELL_ALL, AI_SYSTEM_PROMPT } from '../lib/analyst.js';
import { unsupportedFigures, materialFigures } from '../lib/grounding.js';
import { conversationalAnswer, termsIn } from '../lib/glossary.js';
import { traderAnswer, TRADER_Q, isTraderFollowUp } from '../lib/traderchat.js';
import { aiState, deviceSupport, loadLocalModel, askLLM, localReady, customReady, customState, recommendedModelId, checkCustomAI, AI_HOSTS } from '../ai/engine.js';
import { $, $$, icon, markdown, bindSeg, toast } from '../ui.js';
import { esc, price, changeHtml, money} from '../format.js';
import { settings, load, save } from '../store.js';

export const title = 'Assistant';
// The conversation is kept on this device and with the account (cloudsync.js),
// so the assistant remembers it after a reload and on another device. It used
// to live in memory only, and every reload started from nothing.
const HISTORY_KEY = 'assistantHistory';
const KEEP = 30;
const history = [];
function restoreHistory() {
  const saved = load(HISTORY_KEY, null);
  history.length = 0;
  for (const m of Array.isArray(saved?.messages) ? saved.messages : []) if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') history.push(m);
  history.lastSymbol = (typeof saved?.lastSymbol === 'string' && /^[\p{L}\p{N}_]{1,20}$/u.test(saved.lastSymbol) ? saved.lastSymbol : null) || history.lastSymbol;
}
let savingHere = false; // this page's own saves are not news from another device
function saveHistory() {
  const value = {
    // the "show data used" link needs the answer's data, which is not kept
    messages: history.slice(-KEEP).map((m) => ({ role: m.role, content: String(m.content).slice(0, 6000), ...(m.root ? { root: String(m.root).slice(0, 500) } : {}), ...(m.meta ? { meta: String(m.meta).replace(/<a href="#" data-facts>[^<]*<\/a>/, '') } : {}), at: m.at || Date.now() })),
    lastSymbol: history.lastSymbol || null,
  };
  savingHere = true;
  try { save(HISTORY_KEY, value); } finally { savingHere = false; }
}

export async function render(el, [symParam]) {
  restoreHistory();
  const all = await markets().catch(() => []);
  const st = { symbol: (symParam || history.lastSymbol || 'BTC').toUpperCase(), interval: '4h', busy: false, abort: null, disposed: false };
  const support = await deviceSupport();
  const s = settings.get();

  el.innerHTML = `
    <div class="page-head"><div><h1>Assistant</h1><p>Answers are built on your device from live prices, signals, backtests and the forecast. Your questions stay on this device unless you connect your own AI service, and no account or API key is needed.</p></div><div class="row"><button class="btn sm" type="button" id="assistantStop" disabled>Stop</button><button class="btn sm ghost" type="button" id="assistantClear">Clear chat</button></div></div>
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
            <select class="inp" id="coinSel" aria-label="Coin in focus" style="flex:1">${all.filter((c) => !isStable(c.symbol)).slice(0, 150).map((c) => `<option value="${esc(c.symbol)}" ${c.symbol === st.symbol ? 'selected' : ''}>${esc(c.symbol)} · ${esc(c.name)}</option>`).join('')}</select>
          </div>
          <div class="row"><span class="fine">Chart</span><div class="seg" id="ivSeg">${['1m', '5m', '15m', '1h', '4h', '1d'].map((iv) => `<button data-v="${iv}" class="${iv === st.interval ? 'on' : ''}">${iv}</button>`).join('')}</div></div>
          <div id="focus" class="mt fine"></div>
        </div>
        <div class="card fine">
          <b>How the assistant works</b>
          <ol style="padding-left:18px;margin:6px 0 0">
            <li>Pulls live candles from Binance for the coin you ask about.</li>
            <li>Computes readings on 4 timeframes, a backtest, and the forecast (7 models including pattern matching, a neural network and gradient-boosted trees, each weighted by its measured accuracy).</li>
            <li>A built-in analyst — or a language model running on your device, if you turn one on — turns those verified numbers into a plain-English answer.</li>
          </ol>
          <p class="mt">Not financial advice. The assistant cannot place trades.</p>
        </div>
      </div>
    </div>`;

  const log = $('#log', el);
  // The focus panel used to print the price fetched when the page loaded and
  // never touch it again, so after a few minutes it disagreed with the live
  // ticker at the top of the same screen. It now rides the same stream.
  // One subscription at a time, swapped when the reader changes coin.
  let focusUnsub = null;
  const watchFocus = (pair) => {
    if (focusUnsub) { focusUnsub(); focusUnsub = null; }
    focusUnsub = live.subscribe(`${pair}@miniTicker`, (tk) => {
      const box = $('#focus', el)?.querySelector('[data-focus-px]');
      if (!box) return;
      const p = +tk.c, o = +tk.o;
      if (!Number.isFinite(p) || !Number.isFinite(o) || o === 0) return;
      box.querySelector('.p').textContent = money(p);
      box.querySelector('.chg').outerHTML = changeHtml((p / o - 1) * 100);
      // keep the cached row in step so anything else reading it agrees
      const row = all.find((x) => x.symbol === st.symbol);
      if (row) { row.price = p; row.change24h = (p / o - 1) * 100; }
    });
  };

  const drawFocus = () => {
    const c = all.find((x) => x.symbol === st.symbol);
    $('#focus', el).innerHTML = c ? `<div class="row spread"><a class="acc" href="#/coin/${esc(c.symbol)}">${esc(c.name)} chart →</a><span data-focus-px><b class="p">${money(c.price)}</b> ${changeHtml(c.change24h)}</span></div>` : '';
    if (c?.binance) watchFocus(c.binance);
    const sym = st.symbol;
    $('#suggest', el).innerHTML = [
      'Which coins are most extended right now?', 'Scan every timeframe and show me where the evidence is strongest',
      'What should I hold for weeks, and what is only a quick trade?',
      'Compare BTC, ETH and SOL',
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
    // The built-in engine answers every question; a language model is an
    // optional extra that rewords its answers and adds no knowledge.
    const base = `<p><span class="chip up">● Ready</span></p><p class="fine">Answers instantly from live prices and the app's tested models, on this device. Nothing to download, no account, no API key, and every figure in an answer comes from that data.</p>`;
    let extra = '';
    if (customReady()) {
      extra = customState.reached
        ? `<p class="fine mt"><span class="chip up">● Connected</span> Your AI endpoint <b>${esc(settings.get().customModel || '')}</b> words the answers.</p>`
        : `<p class="fine mt"><span class="chip warn">● Configured, not yet reached</span> Your endpoint <b>${esc(settings.get().customModel || '')}</b> is tried when you ask; if it cannot be reached, the built-in answer is shown.${customState.lastError ? `<br><small class="down">Last attempt: ${esc(customState.lastError)}</small>` : ''}</p>`;
    } else if (status === 'ready') {
      extra = `<p class="fine mt"><span class="chip up">● Language model on</span> ${esc(aiState.model)} rewords the answers on this device.</p>`;
    } else if (status === 'loading') {
      extra = `<p class="row mt"><span class="spinner"></span><b>Loading the language model…</b></p><div class="meter"><i style="width:${Math.round(aiState.progress * 100)}%"></i></div><p class="fine mt">${esc(aiState.text.slice(0, 140))}</p><p class="fine">Answers keep coming from the built-in engine meanwhile.</p>`;
    } else if (support.webgpu) {
      extra = `<details class="mt"><summary class="fine" style="cursor:pointer">Optional: let a language model reword the answers</summary>
        <p class="fine mt">A free model that runs inside your browser (WebGPU) and puts the same answers in its own words. It adds no knowledge: the facts still come from the built-in engine. It downloads once (${(() => { const gb = CONFIG.LLM_MODELS.map((m) => parseFloat(String(m.size).replace(/[^\d.]/g, ''))).filter(Number.isFinite); return gb.length ? `about ${Math.min(...gb)} to ${Math.max(...gb)} GB, by model` : 'size by model'; })()}) and then loads from cache.</p>
        <label class="fld mt">Model<select class="inp" id="modelSel">${opts}</select></label>
        <button class="btn mt" id="startAi" style="width:100%">${icon('chip', 16)} Load the language model</button>
        ${status === 'error' ? `<p class="fine down mt">${esc(aiState.text)}</p>` : ''}</details>`;
    }
    const body = base + extra;
    card.innerHTML = `<div class="card-h"><h3>${icon('ai', 16)} CoinVantage AI · built in</h3></div>${body}
      <details class="mt"><summary class="fine" style="cursor:pointer">Advanced: use your own AI server</summary>
        <form id="customForm" class="stack mt" style="gap:8px">
          <label class="fld">OpenAI-compatible URL<input class="inp" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="300" placeholder="http://localhost:11434/v1" value="${esc(settings.get().customEndpoint)}"></label>
          <label class="fld">Model name<input class="inp" name="model" autocomplete="off" spellcheck="false" maxlength="120" placeholder="llama3.1" value="${esc(settings.get().customModel)}"></label>
          <label class="fld">API key (optional)<input class="inp" name="key" type="password" autocomplete="off" maxlength="400" value="${esc(settings.get().customKey)}"></label>
          <p class="fine down" id="customErr" role="alert" hidden></p>
          <div class="row"><button class="btn sm primary">Save</button><button class="btn sm" type="button" id="clearCustom">Remove</button></div>
          <p class="fine">Works with Ollama, LM Studio, vLLM on this computer, or ${esc(AI_HOSTS.join(', '))}. It only rewords the built-in engine's answer: the facts and figures still come from the engine, and figures it cannot find in the data are flagged. The key stays in this browser. Ollama only answers other websites when started with <code>OLLAMA_ORIGINS=${esc(location.origin)}</code>; in LM Studio, turn on CORS in the server settings.</p>
        </form></details>`;
    $('#startAi', card)?.addEventListener('click', async () => {
      try { await loadLocalModel($('#modelSel', card).value); toast('The language model is on', 'up'); }
      catch (e) { toast(e.message, 'down'); }
    });
    $('#customForm', card).addEventListener('submit', (e) => {
      e.preventDefault();
      const ok = checkCustomAI({ url: e.target.url.value, model: e.target.model.value, key: e.target.key.value });
      const err = $('#customErr', card);
      if (!ok.ok) {
        err.textContent = ok.error; err.hidden = false;
        e.target[ok.field]?.setAttribute('aria-invalid', 'true');
        e.target[ok.field]?.focus();
        return;
      }
      settings.set({ customEndpoint: ok.url, customModel: ok.model, customKey: ok.key });
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
      addMsg('bot', markdown(`**Ask me anything about the market.**

Start broad — *"What should I buy right now?"* — and I'll read every coin across three horizons (short term, swing and position) and tell you which, if any, clear the evidence bar, with an entry, a stop and a target for those that do.

Or ask about one coin: *"Is ETH worth buying this week?"* · *"Where should I sell SOL?"* · *"How is my portfolio doing?"*

Every answer is built from live prices, signals across four timeframes, a backtest, and a forecast whose accuracy is measured and published — never a guess dressed up as a number.`));
    }
    for (const m of history) addMsg(m.role === 'user' ? 'user' : 'bot', m.role === 'user' ? esc(m.content) : markdown(m.content) + (m.meta ? `<div class="src">${m.meta}</div>` : ''));
  };

  async function ask(question) {
    question = question.trim();
    if (!question || st.busy) return;
    st.busy = true;
    $('#send', el).disabled = true;
    $('#assistantClear', el).disabled = true;
    // "why?" or "what should I change?" right after a question about the AI
    // trader is about the trader, not a new topic; a chain of them stays on it
    // (each keeps the question that started it)
    const last = [...history].reverse().find((m) => m.role === 'user');
    const previous = last ? last.root || last.content : '';
    const followUp = isTraderFollowUp(question, previous);
    const root = followUp ? previous : TRADER_Q.test(question) ? question : null;
    history.push({ role: 'user', content: question, at: Date.now(), ...(root ? { root } : {}) });
    saveHistory();
    addMsg('user', esc(question));
    const bot = addMsg('bot', '<span class="typing"><i></i><i></i><i></i></span> <span class="fine" data-step>Thinking…</span>');
    const step = (t) => { const n = bot.querySelector('[data-step]'); if (n) n.textContent = t; };
    try {
      const wantsPortfolio = SELL_ALL.test(question) || /(portfolio|wallet|holding|my coins)/i.test(question);
      const found = await detectSymbol(question);
      // "What is ATR?" must not turn ATR into a coin when a token shares the name.
      const detected = found && termsIn(found).length && !namedCoins(question).includes(found) ? null : found;
      // Greetings, definitions, "how does it work" and "is it a scam" need no
      // chart: answer at once instead of fetching and reading one.
      const plain = !followUp && !TRADER_Q.test(question) && conversationalAnswer(question, { symbol: st.symbol, named: detected ? [detected] : namedCoins(question) });
      if (plain) {
        const src = '<span>Built-in answer (instant)</span>';
        history.push({ role: 'assistant', content: plain, meta: src, at: Date.now() });
        bot.innerHTML = markdown(plain) + `<div class="src">${src}</div>`;
        return;
      }
      // "Which coin should I buy?" is about the whole market — only treat it as
      // a single-coin question when the user actually named a coin.
      const wantsMarket = isMarketWide(question) && !detected;
      if (detected && detected !== st.symbol) { st.symbol = detected; $('#coinSel', el).value = detected; drawFocus(); }
      history.lastSymbol = st.symbol;
      const portfolio = await portfolioSummary();

      // A question about the AI trader is answered from the user's own account,
      // not from a market scan of the coin in focus.
      const trader = traderAnswer(followUp ? `${previous} ${question}` : question, { state: load('traderState', null), saved: load('traderCfg', {}), lessons: load('traderLessons', []), symbol: detected, fmt: (v) => money(v), followUp, latest: question });

      let analysis = null, market = null, marketFrames = null, compare = null;
      // the span the question names picks the chart; otherwise the one chosen on the page
      const iv = horizonChart(question) || st.interval;
      const wantsCompare = !trader && detectCompare(question);
      if (trader) {
        // nothing to fetch: the account is on this device
      } else if (wantsCompare) {
        step(`Comparing ${wantsCompare.join(', ')}…`);
        compare = await compareCoins(wantsCompare, { interval: iv, onStep: step });
      } else if (wantsMarket) {
        step('Scanning every coin on 3 timeframes…');
        const byInterval = await scanMarketMulti({ count: 20, onStep: step });
        marketFrames = marketContextMulti(byInterval);
        market = marketFrames.frames.find((f) => f.interval === iv) || marketFrames.frames[1] || marketFrames.frames[0] || null;
      } else if (!wantsPortfolio || detected) {
        analysis = await analyzeCoin(st.symbol, { interval: iv, onStep: step });
      }
      const ctx = analysis
        ? { ...analystContext(analysis, portfolio), market, marketFrames, compare, compareInterval: iv }
        : { portfolio, market, marketFrames, compare, compareInterval: iv, interval: iv };
      const facts = trader ? trader.text : ruleBasedAnswer(question, ctx);
      const meta = (src) => `<span>${esc(src)}</span>${marketFrames ? `<span>· scanned ${marketFrames.scanned} coins on ${esc(marketFrames.intervals.join(', '))}</span>` : market ? `<span>· scanned ${market.scanned} coins on ${esc(market.interval)}</span>` : ''}${analysis ? `<span>· ${esc(analysis.coin.symbol)} ${esc(analysis.interval)} · ${analysis.source === 'binance' ? 'live Binance data' : analysis.source === 'demo' ? 'demo data' : 'CoinGecko data'}</span>` : ''}<a href="#" data-facts>· show data used</a>`;
      let finalText = facts, source = 'Rule-based analyst (instant)';
      if (localReady() || customReady()) {
        step('Writing answer…');
        const ac = new AbortController(); st.abort = ac;
        $('#assistantStop', el).disabled = false;
        try {
          const data = trader ? trader.data : analysis ? llmData(analysis) : {};
          if (compare) data.comparison = compare;
          if (marketFrames) data.marketByTimeframe = marketFrames;
          else if (market) data.marketPicks = market;
          if (portfolio.length) data.portfolio = portfolio.map((p) => ({ coin: p.symbol, valueUsd: Math.round(p.value), pnlPct: p.pnlPct !== null ? +p.pnlPct.toFixed(1) : null }));
          const r = await askLLM({ history: history.slice(0, -1), question, facts, data, signal: ac.signal, onText: (t) => { bot.innerHTML = markdown(t); log.scrollTop = log.scrollHeight; } });
          // A figure the model was not given is checked before the answer is
          // kept: a few means the analyst's own answer is shown instead, one or
          // two are pointed out under the answer.
          const bad = r.text.trim().length > 20 ? unsupportedFigures(r.text, [facts, JSON.stringify(data), AI_SYSTEM_PROMPT, ...history.filter((m) => m.role === 'user').map((m) => m.content)]) : [];
          if (r.text.trim().length <= 20) source = 'Rule-based analyst (the AI model gave no answer)';
          else if (bad.length >= 3 || (bad.length === 2 && materialFigures(r.text) < 4)) source = `Rule-based analyst (the AI's answer quoted figures not in the data: ${bad.slice(0, 3).join(', ')})`;
          else {
            finalText = r.text;
            if (r.cut) finalText += "\n\n_Cut short at the model's length limit; the full verified answer is under “show data used”._";
            if (bad.length) finalText += `\n\n_Not in the verified data: ${bad.join(', ')}. Check against “show data used”._`;
            if (!/not financial advice/i.test(finalText)) finalText += '\n\nNot financial advice.';
            source = `${r.source} · ${r.where === 'device' ? 'language model on this device' : 'your AI server'}`;
          }
        } catch (err) {
          if (ac.signal.aborted) source = 'Rule-based analyst (stopped)';
          else {
            console.warn('LLM failed, using analyst', err);
            source = 'Rule-based analyst (AI model unavailable)';
          }
        }
      }
      history.push({ role: 'assistant', content: finalText, meta: meta(source), at: Date.now() });
      bot.innerHTML = markdown(finalText) + `<div class="src">${meta(source)}</div>`;
      bot.querySelector('[data-facts]')?.addEventListener('click', (e) => { e.preventDefault(); addMsg('bot', `<div class="fine"><b>Verified data behind this answer</b></div>${markdown(facts)}`); });
    } catch (err) {
      bot.innerHTML = markdown(`Sorry — ${err.message}`);
      history.push({ role: 'assistant', content: `Sorry — ${err.message}`, at: Date.now() });
    } finally {
      saveHistory();
      st.busy = false; st.abort = null;
      if (!st.disposed) {
        $('#send', el).disabled = false;
        $('#assistantStop', el).disabled = true;
        $('#assistantClear', el).disabled = false;
      }
      log.scrollTop = log.scrollHeight;
    }
  }

  // Stop ends the language model's write-up; the instant analyst answer, built
  // from the same verified numbers, is shown instead.
  $('#assistantStop', el).addEventListener('click', () => st.abort?.abort());
  $('#assistantClear', el).addEventListener('click', () => { if (st.busy) return; history.length = 0; saveHistory(); drawHistory(); });
  $('#form', el).addEventListener('submit', (e) => { e.preventDefault(); const q = $('#q', el); ask(q.value); q.value = ''; });
  $('#q', el).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form', el).requestSubmit(); } });
  $('#coinSel', el).addEventListener('change', (e) => { st.symbol = e.target.value; history.lastSymbol = st.symbol; saveHistory(); drawFocus(); });
  // the conversation from another device, when a sync brings it in
  const onStore = (e) => { if (e.detail?.key === HISTORY_KEY && !savingHere && !st.busy && !st.disposed) { restoreHistory(); drawHistory(); } };
  window.addEventListener('cv:store', onStore);
  bindSeg($('#ivSeg', el), (v) => { st.interval = v; });

  drawHistory(); drawFocus(); drawEngine();

  // Auto-start the local model if this browser already downloaded it before
  if (support.webgpu && s.llmAuto && s.llmModel && aiState.status === 'idle') {
    loadLocalModel(s.llmModel).catch(() => {});
  }
  if (!support.webgpu && !s.llmModel) recommendedModelId();
  return () => { st.disposed = true; st.abort?.abort(); focusUnsub?.(); aiState.removeEventListener('change', onAi); window.removeEventListener('cv:store', onStore); };
}
