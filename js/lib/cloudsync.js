// Keeps a signed-in user's data the same on every device they sign in on: the
// watchlist, portfolio, wallets, chart drawings and settings, and the Trading
// page's three accounts with the AI's rules and what it learned.
//
// Each piece merges on its own, three ways: this device's value, the cloud's,
// and a fingerprint of the value the two last agreed on. Whichever side changed
// since then wins. When both changed, the cloud's copy is kept, so two open
// devices settle on one record instead of overwriting each other in turn; demo
// or real trades that only this device had are set aside so the Trading page can
// offer them back. Two AI accounts that never met keep the one that has run
// longest. A blank value, like the empty row a new account starts with, never
// replaces real data, and what another account left on a shared device is never
// uploaded into this one.
//
// The trading keys were never synced before, so one account showed different
// trades on every phone and laptop. The rest was synced by "newest wins" on
// timestamps from two different clocks, and a new account's blank row wiped the
// portfolio, wallets and drawings a visitor had made before signing up.
//
// Storage and network are passed in, so all of this runs under Node in the tests.

export const COLUMN_KEYS = ['watchlist', 'holdings', 'wallets', 'drawings', 'settings'];
export const TRADING_KEYS = [
  'traderState', 'myDemoState', 'realTradeState',     // the three accounts
  'traderCfg', 'traderLessons', 'traderAutoLearn',    // the AI's rules and what it learned
  'traderRunning', 'aiSession', 'traderAutoStarted',  // whether the AI is running
];
export const SYNCED_KEYS = [...COLUMN_KEYS, ...TRADING_KEYS];
export const ACCOUNT_KEYS = ['traderState', 'myDemoState', 'realTradeState'];
/** The accounts holding trades the user made; the AI's own account is not one. */
export const OWN_ACCOUNTS = ['myDemoState', 'realTradeState'];
/** The settings that follow the account; the rest stay per device. */
export const SETTINGS_FIELDS = ['theme', 'interval', 'currency', 'lang', 'llmModel', 'digest'];
const META_KEY = 'syncMeta';      // { user, base: { key: fingerprint } }
const BACKUP_KEY = 'syncBackup';  // { at, user, keys: { account: value } }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const val = (v) => (v === undefined ? null : v);

/**
 * JSON with object keys sorted. The database stores objects with their keys
 * reordered, so a value that went up and came back must still compare equal.
 */
export function canon(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map((x) => canon(x)).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** A short fingerprint of a value (53-bit hash of its canonical JSON, plus length). */
export function fingerprint(v) {
  const s = canon(v);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${s.length.toString(36)}.${(h2 >>> 0).toString(36)}.${(h1 >>> 0).toString(36)}`;
}

/** Every trade an account holds, open or closed, by coin and opening time. */
export function tradeIds(account) {
  if (!isObj(account)) return new Set();
  const ids = new Set();
  for (const p of Object.values(account.open || {})) if (p) ids.add(`${p.symbol}:${p.openedAt}`);
  for (const t of account.closed || []) if (t) ids.add(`${t.symbol}:${t.openedAt}`);
  return ids;
}

/** Trades in `mine` that `theirs` does not have. */
export function missingTrades(mine, theirs) {
  const have = tradeIds(theirs);
  return [...tradeIds(mine)].filter((id) => !have.has(id));
}

/**
 * Nothing worth keeping: no value, an empty list or object, or one of your own
 * accounts with no trades. The AI's account counts from the moment it starts:
 * before its first trade it already holds its chart and the settings you changed
 * (treating it as empty kept it off new devices, which then started their own
 * and later put that over it).
 */
export function isBlank(v, key) {
  if (v === null || v === undefined) return true;
  if (key === 'traderState') return tradeIds(v).size === 0 && !Number.isFinite(v?.startedAt);
  if (ACCOUNT_KEYS.includes(key)) return tradeIds(v).size === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (isObj(v)) return Object.keys(v).length === 0;
  return false;
}

/**
 * Decide one key. `base` is the fingerprint both sides last agreed on, or
 * undefined if they never have. Returns 'same', 'local' (upload this device's
 * value), 'remote' (take the cloud's), 'conflict' (both changed: take the
 * cloud's) or 'keep' (leave this device alone and upload nothing).
 */
export function decide(local, remote, base, key) {
  const l = val(local), r = val(remote);
  const fl = fingerprint(l), fr = fingerprint(r);
  if (fl === fr) return 'same';
  if (l === null) return isBlank(r, key) ? 'keep' : 'remote';   // a blank cloud value never replaces the defaults
  if (r === null) return 'local';                                 // the cloud does not have it yet
  if (base !== undefined) {
    if (fr === base) return 'local';      // only this device changed it
    if (fl === base) return 'remote';     // only another device changed it
    return 'conflict';                    // both did: the cloud's copy wins
  }
  // The two never agreed on this key: this device's first sync with the account.
  if (isBlank(r, key)) return isBlank(l, key) ? 'keep' : 'local';
  if (isBlank(l, key)) return 'remote';
  // Two AI accounts that never met: keep the one that has been running longest,
  // with trades or not, so one a device started while the cloud's was on its way
  // never replaces it. Two copies of the same account keep the one further on.
  if (key === 'traderState') {
    if (Number.isFinite(l.startedAt) && Number.isFinite(r.startedAt) && l.startedAt !== r.startedAt) return l.startedAt < r.startedAt ? 'local' : 'conflict';
    if (tradeIds(l).size > tradeIds(r).size) return 'local';
  }
  return 'conflict';
}

/**
 * Merge every key. Returns the value to keep for each key, the keys to upload,
 * the keys taken from the cloud, the conflicts, and the fingerprints both sides
 * now agree on (uploads are added once they have gone up).
 */
export function mergeAll(local, remote, base = {}) {
  const keys = {}, upload = [], download = [], conflicts = [], agreed = { ...base };
  for (const k of SYNCED_KEYS) {
    const l = val(local?.[k]), r = val(remote?.[k]);
    const d = decide(l, r, base[k], k);
    if (d === 'same') { keys[k] = l; if (r !== null) agreed[k] = fingerprint(r); }
    else if (d === 'local') { keys[k] = l; upload.push(k); }
    else if (d === 'keep') keys[k] = l;
    else {
      keys[k] = r;
      download.push(k);
      agreed[k] = fingerprint(r);
      if (d === 'conflict') conflicts.push(k);
    }
  }
  return { keys, upload, download, conflicts, agreed };
}

/**
 * Data another account left on this device: take this account's values where
 * it has them and clear the rest, uploading nothing.
 */
export function takeOver(local, remote) {
  const keys = {}, download = [], clear = [], agreed = {};
  for (const k of SYNCED_KEYS) {
    const l = val(local?.[k]), r = val(remote?.[k]);
    if (!isBlank(r, k)) {
      keys[k] = r;
      agreed[k] = fingerprint(r);
      if (fingerprint(l) !== agreed[k]) download.push(k);
    } else {
      keys[k] = null;
      if (l !== null && k !== 'settings') clear.push(k);   // settings are this device's look, not the other account's data
    }
  }
  return { keys, upload: [], download, clear, conflicts: [], agreed };
}

/** The synced values held in a user_data row. */
export function fromRow(row) {
  const out = {};
  for (const k of COLUMN_KEYS) out[k] = val(row?.[k]);
  const t = isObj(row?.trading) ? row.trading : {};
  for (const k of TRADING_KEYS) out[k] = val(t[k]);
  return out;
}

/** What to send for the keys in `upload`: whole columns, and trading keys one by one. */
export function toPatch(keys, upload) {
  const cols = {}, trading = {};
  for (const k of upload) {
    if (keys[k] === null || keys[k] === undefined) continue;
    if (COLUMN_KEYS.includes(k)) cols[k] = keys[k];
    else trading[k] = keys[k];
  }
  return { cols, trading };
}

const pick = (o, fields) => Object.fromEntries(fields.filter((f) => o?.[f] !== undefined).map((f) => [f, o[f]]));

/**
 * The sync engine. `store` is { load, save, remove }, `cloud` is { user, pull,
 * push } (pull returns the row or null and throws when it cannot reach the
 * server; push(patch) throws on failure), `settings` is { get, set }.
 * `onApplied(keys)` runs after values from the cloud were written here.
 */
export function createSync({ store, cloud, settings, onApplied = () => {} }) {
  let applying = false, running = null, again = false;

  const readLocal = () => {
    const out = {};
    for (const k of COLUMN_KEYS) out[k] = k === 'settings' ? pick(settings.get(), SETTINGS_FIELDS) : val(store.load(k, null));
    for (const k of TRADING_KEYS) out[k] = val(store.load(k, null));
    return out;
  };

  function write(k, v) {
    if (k === 'settings') settings.set(pick(v, SETTINGS_FIELDS));
    else if (v === null) store.remove(k);
    else store.save(k, v);
  }

  // Set aside trades the user made that only this device had, before the cloud's
  // copy replaced them: one copy per account until the user restores or
  // dismisses it. The AI's account is not set aside; its trades are replays of
  // the same rules, which every device redoes from the copy it keeps.
  function backUp(user, local, remote, conflicts) {
    const prev = store.load(BACKUP_KEY, null);
    const keys = { ...(prev?.user === user ? prev.keys : {}) };
    let added = false;
    for (const k of conflicts) {
      if (!OWN_ACCOUNTS.includes(k) || keys[k]) continue;
      if (!missingTrades(local[k], remote[k]).length) continue;
      keys[k] = local[k];
      added = true;
    }
    if (added) store.save(BACKUP_KEY, { at: Date.now(), user, keys });
  }

  async function once() {
    const user = cloud.user();
    if (!user) return { skipped: true };
    const row = await cloud.pull();
    if (cloud.user() !== user) return { skipped: true };   // signed out or switched while it loaded
    const meta = store.load(META_KEY, null);
    const foreign = !!meta?.user && meta.user !== user;
    const local = readLocal();
    const remote = fromRow(row);
    const base = !foreign && meta?.user === user ? meta.base || {} : {};
    const m = foreign ? takeOver(local, remote) : mergeAll(local, remote, base);
    if (foreign) store.remove(BACKUP_KEY);
    else backUp(user, local, remote, m.conflicts);
    const applied = [...m.download, ...(m.clear || [])];
    applying = true;
    try { for (const k of applied) write(k, m.keys[k]); } finally { applying = false; }
    const agreed = m.agreed;
    store.save(META_KEY, { user, base: agreed });
    if (applied.length) onApplied(applied);
    if (m.upload.length) {
      await cloud.push(toPatch(m.keys, m.upload));
      if (cloud.user() === user) {
        for (const k of m.upload) agreed[k] = fingerprint(m.keys[k]);
        store.save(META_KEY, { user, base: agreed });
      }
    }
    return { applied, uploaded: m.upload, conflicts: m.conflicts, foreign };
  }

  /** Run a sync; calls made while one is running fold into one more run after it. */
  function sync() {
    if (running) { again = true; return running; }
    running = (async () => {
      let last;
      try {
        do { again = false; last = await once(); } while (again);
        return last;
      } finally { running = null; }
    })();
    return running;
  }

  return {
    sync,
    /** True while values from the cloud are being written here (not a user's edit). */
    get applying() { return applying; },
    readLocal,
  };
}

/** Trades set aside from this device for `user`, if any are worth offering back. */
export function backupFor(load, user) {
  const b = load(BACKUP_KEY, null);
  if (!b || b.user !== user || !isObj(b.keys)) return null;
  const keys = Object.fromEntries(Object.entries(b.keys).filter(([k, v]) => OWN_ACCOUNTS.includes(k) && tradeIds(v).size));
  return Object.keys(keys).length ? { at: b.at, keys } : null;
}

/**
 * Put the set-aside copies back in place of the account's. They count as edits
 * on this device, so the next sync sends them up. Returns the keys restored.
 */
export function restoreBackup({ load, save, remove }, user) {
  const b = backupFor(load, user);
  remove(BACKUP_KEY);
  if (!b) return [];
  for (const [k, v] of Object.entries(b.keys)) save(k, v);
  return Object.keys(b.keys);
}

export { BACKUP_KEY, META_KEY };
