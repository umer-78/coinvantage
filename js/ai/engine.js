// Built-in AI assistant.
//  • Local LLM: runs in the visitor's browser with WebGPU (WebLLM). Free, private, no API key.
//  • Optional: any OpenAI-compatible endpoint (e.g. your own Ollama server) set in AI settings.
//  • Always available: rule-based analyst (instant, works on every device).
import { CONFIG } from '../config.js';
import { settings } from '../store.js';
import { AI_SYSTEM_PROMPT } from '../lib/analyst.js';

export const aiState = new EventTarget();
aiState.status = 'idle'; // idle | unsupported | loading | ready | error
aiState.progress = 0;
aiState.text = '';
aiState.model = null;

let engine = null;
let webllm = null;
let loadingPromise = null;

function emit(status, extra = {}) {
  Object.assign(aiState, { status, ...extra });
  aiState.dispatchEvent(new CustomEvent('change'));
}

export async function deviceSupport() {
  const info = { webgpu: false, f16: false, mobile: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent), memoryGB: navigator.deviceMemory || null };
  if (!('gpu' in navigator)) return info;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) { info.webgpu = true; info.f16 = adapter.features.has('shader-f16'); }
  } catch { /* no adapter */ }
  return info;
}

export async function recommendedModelId() {
  const s = await deviceSupport();
  if (!s.webgpu) return null;
  const small = s.mobile || (s.memoryGB && s.memoryGB <= 4);
  return (small ? CONFIG.LLM_MODELS.find((m) => m.tier === 'small') : CONFIG.LLM_MODELS[0]).id;
}

export function isModelCached(id) {
  return webllm?.hasModelInCache ? webllm.hasModelInCache(id).catch(() => false) : Promise.resolve(false);
}

export async function loadLocalModel(modelId) {
  if (engine && aiState.model === modelId) return engine;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const support = await deviceSupport();
    if (!support.webgpu) {
      emit('unsupported', { text: 'This browser/device has no WebGPU, so the local LLM cannot run here. The rule-based analyst is used instead.' });
      throw new Error('WebGPU not available');
    }
    emit('loading', { progress: 0, text: 'Loading AI runtime…' });
    try {
      webllm = webllm || (await import(/* @vite-ignore */ CONFIG.WEBLLM_URL));
      let id = modelId || (await recommendedModelId());
      if (!support.f16) id = id.replace('q4f16_1', 'q4f32_1');
      const known = webllm.prebuiltAppConfig?.model_list?.map((m) => m.model_id) || [];
      if (known.length && !known.includes(id)) {
        id = [CONFIG.LLM_MODELS[0].id, 'Qwen3-1.7B-q4f16_1-MLC', 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'].map((x) => (support.f16 ? x : x.replace('q4f16_1', 'q4f32_1'))).find((x) => known.includes(x)) || known[0];
      }
      if (engine) { try { await engine.unload(); } catch { /* ignore */ } }
      engine = await webllm.CreateMLCEngine(id, {
        initProgressCallback: (r) => emit('loading', { progress: r.progress ?? 0, text: r.text || 'Downloading model…' }),
      });
      emit('ready', { model: id, progress: 1, text: 'Ready' });
      settings.set({ llmModel: id, llmAuto: true });
      return engine;
    } catch (err) {
      engine = null;
      emit('error', { text: `Could not start the local AI: ${err.message}` });
      throw err;
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

// Every model offered here has a 4,096-token window (WebLLM 0.2.85's model
// list) that the prompt and the answer share. The prompt used to be capped in
// characters only: a coin's data plus a few turns of chat went over, the local
// model refused the request and the answer quietly came from the rule-based
// analyst; just under the limit, the answer was cut off mid-line. Your own
// server gets the same budget, since Ollama and LM Studio default to 4,096
// tokens too and Ollama cuts the start of a longer prompt (the instructions).
export const CONTEXT_TOKENS = 4096;
export const ANSWER_TOKENS = 700;
const SLACK = 64; // chat-template markers

/**
 * A token count that errs high. Qwen's tokenizer spends a token on every
 * digit, so price data is far denser than prose. Fitted on this app's own
 * prompts against the Qwen3 and Llama 3.2 tokenizers: never below the larger
 * of the two counts, about 15% above it on average.
 */
export function estimateTokens(text) {
  let n = 0;
  for (const ch of String(text ?? '')) {
    if (ch >= '0' && ch <= '9') n += 1;
    else if (/[A-Za-z]/.test(ch)) n += 1 / 6;
    else if (ch < '\u0080') n += 0.7;
    else n += 1.5;
  }
  return Math.ceil(n);
}

// Detail the language model can do without, least useful first.
const TRIM = [['aiForecast', 'models'], ['aiForecast', 'patternMatches'], ['aiForecast', 'notes'], ['recentHeadlines'], ['multiYearHistory'], ['moveTiming'], ['timeframes']];

function shortenArrays(v, max) {
  if (Array.isArray(v)) return v.slice(0, max).map((x) => shortenArrays(x, max));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shortenArrays(x, max)]));
  return v;
}

/**
 * The data as JSON within `limit` (characters, or whatever `size` measures),
 * still valid JSON. It used to be cut at 5,000 characters mid-value, and the
 * comparison, market scan and portfolio are added last, so they were what got
 * lost. Now the bulkiest detail goes first, then long lists are shortened,
 * then whole low-priority sections are left out.
 */
export function fitJson(data, limit = 5000, size = (x) => x.length) {
  let d = JSON.parse(JSON.stringify(data ?? {}));
  let s = JSON.stringify(d);
  for (const path of TRIM) {
    if (size(s) <= limit) return s;
    const parent = path.length > 1 ? d[path[0]] : d;
    if (parent && typeof parent === 'object') delete parent[path[path.length - 1]];
    s = JSON.stringify(d);
  }
  for (const max of [8, 5, 3]) {
    if (size(s) <= limit) return s;
    d = shortenArrays(d, max);
    s = JSON.stringify(d);
  }
  const keep = ['coin', 'question', 'comparison', 'marketByTimeframe', 'marketPicks', 'portfolio', 'signal', 'aiForecast', 'price', 'chart'];
  for (const k of Object.keys(d).filter((key) => !keep.includes(key))) {
    if (size(s) <= limit) return s;
    delete d[k];
    s = JSON.stringify(d);
  }
  for (const k of [...keep].reverse()) {
    if (size(s) <= limit) return s;
    delete d[k];
    s = JSON.stringify(d);
  }
  return size(s) <= limit ? s : '{}';
}

// Text within `limit` tokens, cut at a line break.
function fitText(text, limit) {
  if (estimateTokens(text) <= limit) return text;
  const out = [];
  let used = 1;
  for (const line of String(text).split('\n')) {
    used += estimateTokens(line) + 1;
    if (used > limit) break;
    out.push(line);
  }
  return `${out.join('\n')}\n…`;
}

/**
 * The chat for one question, within the model's window with room left for
 * the answer. In order of need: the instructions and the question, the
 * verified answer (FACTS), the last turn or two of the chat, then the raw
 * data with its least useful detail dropped first.
 */
export function buildMessages(history, question, facts, data, { context = CONTEXT_TOKENS, answer = ANSWER_TOKENS } = {}) {
  let left = context - answer - SLACK - estimateTokens(AI_SYSTEM_PROMPT) - estimateTokens(question) - 20;
  const f = fitText(facts, Math.floor(left * 0.45));
  left -= estimateTokens(f);
  const recent = [];
  let room = Math.floor(left * 0.35);
  for (const m of history.slice(-6).reverse()) {
    const content = m.content.length > 1200 ? `${m.content.slice(0, 1200)}…` : m.content;
    const t = estimateTokens(content) + 6;
    if (t > room) break;
    recent.unshift({ role: m.role, content });
    room -= t; left -= t;
  }
  // a chat starts with the user's turn; some servers reject one that does not
  while (recent[0] && recent[0].role !== 'user') left += estimateTokens(recent.shift().content) + 6;
  const user = `FACTS (verified analysis):\n${f}\n\nDATA (JSON):\n${fitJson(data, Math.max(0, left), estimateTokens)}\n\nQUESTION: ${question}`;
  return [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...recent, { role: 'user', content: user }];
}

// A request the model refused for being longer than its window.
const tooLong = (err) => err?.name === 'ContextWindowSizeExceededError' || /context (window|length)|maximum context|too many tokens|prompt is too long/i.test(String(err?.message || ''));

const stripThink = (t) => t.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');

// Streams an answer. Returns { text, source, cut } — cut: the answer stopped
// at its length limit, not at its end.
export async function askLLM({ history, question, facts, data, onText, signal }) {
  const custom = settings.get().customEndpoint;
  let err;
  // Rebuilt smaller, once, if the model still finds the prompt too long: the
  // token count here is an estimate, and your own server's window may be smaller.
  for (const context of [CONTEXT_TOKENS, Math.round(CONTEXT_TOKENS * 0.6)]) {
    const messages = buildMessages(history, question, facts, data, { context });
    try {
      return await (custom ? askEndpoint(messages, { onText, signal }) : askLocal(messages, { onText, signal }));
    } catch (e) {
      if (signal?.aborted || !tooLong(e)) throw e;
      err = e;
    }
  }
  throw err;
}

// A plain http:// address on another machine is blocked from an https page,
// and Ollama and LM Studio refuse other websites until told to allow them.
const UNREACHABLE = 'could not reach it from the browser. Check the server is running and allows this site (Ollama: set OLLAMA_ORIGINS; LM Studio: turn on CORS). A plain http:// address on another machine is blocked; use https, or run the model on this computer';
const WAIT_MS = 90e3; // a model loading on your server can take a while to answer

async function askEndpoint(messages, { onText, signal }) {
  const s = settings.get();
  // Record whether this endpoint was actually reached, so the panel can stop
  // reporting "Connected" for an address that has never answered.
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), WAIT_MS);
  try {
    let res;
    try {
      res = await fetch(`${s.customEndpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', ...(s.customKey ? { authorization: `Bearer ${s.customKey}` } : {}) },
        body: JSON.stringify({ model: s.customModel || 'default', messages, stream: true, temperature: 0.3, max_tokens: ANSWER_TOKENS }),
      });
    } catch (err) {
      customState.reached = false;
      customState.lastError = ctl.signal.reason?.message === 'timeout' && !signal?.aborted ? `no answer within ${WAIT_MS / 1000} seconds`
        : /Failed to fetch|NetworkError|Load failed/i.test(String(err && err.message)) ? UNREACHABLE : String(err && err.message || err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      customState.reached = false;
      customState.lastError = `endpoint answered ${res.status}${detail ? `: ${detail}` : ''}`;
      throw new Error(`AI endpoint error ${res.status} ${detail}`);
    }
    customState.reached = true;
    customState.lastError = null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', finish = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const m = /^data:\s*(.*)$/.exec(line.trim());
        if (!m || m[1] === '[DONE]') continue;
        try {
          const choice = JSON.parse(m[1]).choices?.[0];
          finish = choice?.finish_reason || finish;
          const delta = choice?.delta?.content;
          if (delta) { text += delta; onText?.(stripThink(text)); }
        } catch { /* partial */ }
      }
    }
    return { text: stripThink(text), source: s.customModel || 'your AI server', where: 'endpoint', cut: finish === 'length' };
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

async function askLocal(messages, { onText, signal }) {
  if (!engine) throw new Error('Local AI not loaded');
  const stream = await engine.chat.completions.create({
    messages, stream: true, temperature: 0.3, top_p: 0.9, max_tokens: ANSWER_TOKENS,
    // Turns off Qwen 3's hidden reasoning. WebLLM adds an empty think block to
    // the answer for any model given this, Llama included, so only Qwen gets it.
    ...(/^Qwen3/i.test(aiState.model || '') ? { extra_body: { enable_thinking: false } } : {}),
  });
  let text = '', finish = null;
  for await (const chunk of stream) {
    if (signal?.aborted) { try { engine.interruptGenerate(); } catch { /* ignore */ } break; }
    const choice = chunk.choices?.[0];
    finish = choice?.finish_reason || finish;
    const delta = choice?.delta?.content || '';
    if (delta) { text += delta; onText?.(stripThink(text)); }
  }
  // A stopped answer is unfinished. It used to come back as if complete and
  // replace the analyst's answer; Stop now ends with the analyst's, as it
  // already did for a connected endpoint.
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  return { text: stripThink(text), source: aiState.model, where: 'device', cut: finish === 'length' };
}

export const localReady = () => !!engine && aiState.status === 'ready';
// Having typed an address is not the same as having reached it. The UI used to
// show "Connected" for any non-empty box, so a wrong URL looked healthy while
// every answer quietly fell back to the rule-based analyst.
export const customReady = () => !!settings.get().customEndpoint;
export const customState = { reached: false, lastError: null };
