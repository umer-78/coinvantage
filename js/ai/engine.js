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

function buildMessages(history, question, facts, data) {
  const recent = history.slice(-6).map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
  const user = `FACTS (verified analysis):\n${facts}\n\nDATA (JSON):\n${JSON.stringify(data).slice(0, 5000)}\n\nQUESTION: ${question}`;
  return [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...recent, { role: 'user', content: user }];
}

const stripThink = (t) => t.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');

// Streams an answer. Returns { text, source }.
export async function askLLM({ history, question, facts, data, onText, signal }) {
  const s = settings.get();
  const messages = buildMessages(history, question, facts, data);

  if (s.customEndpoint) {
    // Record whether this endpoint was actually reached, so the panel can stop
    // reporting "Connected" for an address that has never answered.
    let res;
    try {
      res = await fetch(`${s.customEndpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', ...(s.customKey ? { authorization: `Bearer ${s.customKey}` } : {}) },
        body: JSON.stringify({ model: s.customModel || 'default', messages, stream: true, temperature: 0.3, max_tokens: 700 }),
      });
    } catch (err) {
      customState.reached = false;
      customState.lastError = /Failed to fetch/i.test(String(err && err.message))
        ? 'could not reach it from the browser — a plain http:// address on another machine will be blocked; try https, or run the model on this computer'
        : String(err && err.message || err);
      throw err;
    }
    if (!res.ok || !res.body) {
      customState.reached = false;
      customState.lastError = `endpoint answered ${res.status}`;
      throw new Error(`AI endpoint error ${res.status}`);
    }
    customState.reached = true;
    customState.lastError = null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const m = /^data:\s*(.*)$/.exec(line.trim());
        if (!m || m[1] === '[DONE]') continue;
        try { const delta = JSON.parse(m[1]).choices?.[0]?.delta?.content; if (delta) { text += delta; onText?.(stripThink(text)); } } catch { /* partial */ }
      }
    }
    return { text: stripThink(text), source: s.customModel || 'custom endpoint' };
  }

  if (!engine) throw new Error('Local AI not loaded');
  const stream = await engine.chat.completions.create({
    messages, stream: true, temperature: 0.3, top_p: 0.9, max_tokens: 700,
    extra_body: { enable_thinking: false },
  });
  let text = '';
  for await (const chunk of stream) {
    if (signal?.aborted) { try { engine.interruptGenerate(); } catch { /* ignore */ } break; }
    const delta = chunk.choices?.[0]?.delta?.content || '';
    if (delta) { text += delta; onText?.(stripThink(text)); }
  }
  return { text: stripThink(text), source: aiState.model };
}

export const localReady = () => !!engine && aiState.status === 'ready';
// Having typed an address is not the same as having reached it. The UI used to
// show "Connected" for any non-empty box, so a wrong URL looked healthy while
// every answer quietly fell back to the rule-based analyst.
export const customReady = () => !!settings.get().customEndpoint;
export const customState = { reached: false, lastError: null };
