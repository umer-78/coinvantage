// Run: node --test tests/
// One account must show the same data on every device it signs in on, and no
// device may lose or leak data on the way. These run the real sync engine
// against a fake server that stores rows the way the database does (object keys
// reordered, trading keys merged one by one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSync, decide, isBlank, canon, fingerprint, missingTrades, backupFor, restoreBackup, COLUMN_KEYS } from '../js/lib/cloudsync.js';

// What Postgres jsonb hands back: object keys shortest-first, then bytewise.
function jsonb(v) {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : jsonb(x)));
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, jsonb(v[k])]));
  }
  return v;
}
const copy = (v) => JSON.parse(JSON.stringify(v));

function makeCloud() {
  const rows = new Map();
  const blank = (user) => ({ user_id: user, watchlist: [], holdings: [], wallets: [], drawings: {}, settings: {}, trading: {} });
  return {
    rows,
    signUp(user) { rows.set(user, blank(user)); },   // the signup trigger's blank row
    pull(user) { return rows.has(user) ? jsonb(copy(rows.get(user))) : null; },
    // public.sync_user_data: whole columns, trading keys one by one
    push(user, { cols = {}, trading = {} }) {
      const row = rows.get(user) || blank(user);
      for (const k of COLUMN_KEYS) {
        const want = ['drawings', 'settings'].includes(k) ? 'object' : 'array';
        const v = cols[k];
        if (v !== undefined && v !== null && (Array.isArray(v) ? 'array' : typeof v) === want) row[k] = copy(v);
      }
      row.trading = { ...row.trading, ...copy(trading) };
      rows.set(user, jsonb(row));
    },
  };
}

function makeDevice(cloud) {
  const data = new Map();
  const store = {
    load: (k, fb) => (data.has(k) ? JSON.parse(data.get(k)) : fb),
    save: (k, v) => { data.set(k, JSON.stringify(v)); },
    remove: (k) => { data.delete(k); },
  };
  const settings = {
    get: () => ({ theme: 'dark', interval: '1h', customKey: '', ...store.load('settings', {}) }),
    set(patch) { store.save('settings', { ...settings.get(), ...patch }); },
  };
  const session = { id: null };
  const net = { offline: false, beforePush: null };
  const applied = [];
  const engine = createSync({
    store, settings,
    cloud: {
      user: () => session.id,
      pull: async () => { if (net.offline) throw new Error('offline'); return cloud.pull(session.id); },
      push: async (patch) => {
        if (net.offline) throw new Error('offline');
        if (net.beforePush) { const f = net.beforePush; net.beforePush = null; await f(); }
        cloud.push(session.id, patch);
      },
    },
    onApplied: (keys) => applied.push(keys),
  });
  return { store, settings, session, net, applied, sync: () => engine.sync(), data };
}

// An account in the autotrader's shape; trades are [symbol, openedAt].
const account = (trades, extra = {}) => ({
  version: 2, interval: '1h', startedAt: 1, startingBalance: 10000, balance: 10000 + trades.length,
  open: {}, closed: trades.map(([symbol, openedAt]) => ({ symbol, openedAt, exitAt: openedAt + 1, pnl: 1 })),
  cursor: {}, equityCurve: [], log: [], ...extra,
});
// The AI's next check: deterministic in the account, plus a log line that
// differs per device (the real one records the time of the check).
const aiStep = (acc, device, symbol = 'SOL') => {
  const next = copy(acc);
  next.closed.push({ symbol, openedAt: 1000 + next.closed.length, exitAt: 0, pnl: 1 });
  next.balance += 1;
  next.log = [...next.log, { device }];
  return next;
};
const trades = (acc) => (acc?.closed || []).map((t) => `${t.symbol}:${t.openedAt}`);

test('fingerprints ignore key order and catch any change', () => {
  const a = { open: { BTC: { qty: 1, entry: 2 } }, closed: [{ symbol: 'ETH', pnl: -1 }], balance: 5 };
  const b = jsonb(copy(a));
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'the fake database really reorders keys');
  assert.equal(canon(a), canon(b));
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, balance: 6 }));
  assert.equal(fingerprint({ x: 1, y: undefined }), fingerprint({ x: 1 }));
});

test('each key is decided by what changed since the two last agreed', () => {
  const v1 = ['BTC'], v2 = ['BTC', 'ETH'], v3 = ['SOL'];
  const b = fingerprint(v1);
  assert.equal(decide(v1, v1, b, 'watchlist'), 'same');
  assert.equal(decide(v2, v1, b, 'watchlist'), 'local', 'only this device changed it');
  assert.equal(decide(v1, v2, b, 'watchlist'), 'remote', 'only another device changed it');
  assert.equal(decide(v2, v3, b, 'watchlist'), 'conflict', 'both changed: the cloud wins');
  assert.equal(decide(null, v2, b, 'watchlist'), 'remote', 'a cleared device is filled from the cloud');
  assert.equal(decide(v2, null, undefined, 'watchlist'), 'local', 'the cloud does not have it yet');
  assert.equal(decide(null, [], undefined, 'watchlist'), 'keep', 'a blank cloud value never replaces the defaults');
  assert.equal(decide(v2, [], undefined, 'watchlist'), 'local', 'a blank cloud value never replaces data');
  assert.equal(decide([], v2, undefined, 'watchlist'), 'remote');
  assert.equal(decide(account([['BTC', 1]]), account([]), undefined, 'myDemoState'), 'local', 'your own account with no trades is blank');
  assert.equal(decide(null, account([]), undefined, 'myDemoState'), 'keep');
  assert.equal(decide(null, account([], { startedAt: 5 }), undefined, 'traderState'), 'remote', 'a started AI account comes down before its first trade');
  assert.equal(decide(account([['BTC', 1]], { startedAt: 9 }), account([], { startedAt: 5 }), undefined, 'traderState'), 'conflict', 'one this device started since never replaces it');
  assert.equal(decide(account([], { startedAt: 5 }), account([['BTC', 1]], { startedAt: 9 }), undefined, 'traderState'), 'local');
  assert.equal(decide(account([['BTC', 1]]), account([]), undefined, 'traderState'), 'local', 'two copies of one AI account keep the one further on');
  assert.equal(decide(account([]), account([['BTC', 1]]), undefined, 'traderState'), 'conflict');
  assert.equal(isBlank({ closed: [], open: {} }, 'traderState'), true, 'an AI account that never started is blank');
  assert.equal(decide(account([['BTC', 1]], { startedAt: 1 }), account([['ETH', 2]], { startedAt: 2 }), undefined, 'traderState'), 'local', 'the AI account running longest wins its first merge');
  assert.equal(decide(account([['BTC', 1]], { startedAt: 1 }), account([['ETH', 2]], { startedAt: 2 }), undefined, 'myDemoState'), 'conflict', 'your own trades are never decided by age');
});

test('a visitor who signs up keeps everything made before signing up', async () => {
  const cloud = makeCloud();
  const d = makeDevice(cloud);
  const mine = {
    watchlist: ['BTC', 'PEPE'], holdings: [{ symbol: 'BTC', qty: 0.1 }], wallets: [{ chain: 'eth', address: '0xabc' }],
    drawings: { BTC: [{ kind: 'line' }] }, myDemoState: account([['BTC', 10]]), realTradeState: account([['ETH', 20]]),
  };
  for (const [k, v] of Object.entries(mine)) d.store.save(k, v);
  cloud.signUp('u1');
  d.session.id = 'u1';
  await d.sync();
  for (const [k, v] of Object.entries(mine)) assert.deepEqual(d.store.load(k, null), v, `${k} kept on the device`);
  const row = cloud.rows.get('u1');
  assert.deepEqual(row.holdings, jsonb(mine.holdings));
  assert.deepEqual(row.wallets, jsonb(mine.wallets));
  assert.deepEqual(row.drawings, jsonb(mine.drawings));
  assert.deepEqual(trades(row.trading.myDemoState), ['BTC:10']);
  assert.deepEqual(trades(row.trading.realTradeState), ['ETH:20']);
});

test('trades made on one device show on the other, and neither loses its own', async () => {
  const cloud = makeCloud();
  const phone = makeDevice(cloud), laptop = makeDevice(cloud);
  cloud.signUp('u1');
  phone.session.id = laptop.session.id = 'u1';
  phone.store.save('myDemoState', account([['BTC', 1]]));
  await phone.sync();
  await laptop.sync();
  assert.deepEqual(trades(laptop.store.load('myDemoState')), ['BTC:1'], 'the phone\'s demo trade reached the laptop');
  assert.ok(laptop.applied.flat().includes('myDemoState'));

  laptop.store.save('realTradeState', account([['ETH', 2]]));
  await laptop.sync();
  await phone.sync();
  assert.deepEqual(trades(phone.store.load('realTradeState')), ['ETH:2'], 'the laptop\'s real trade reached the phone');
  assert.deepEqual(trades(phone.store.load('myDemoState')), ['BTC:1'], 'and the phone kept its demo trade');

  // Settled: another round changes nothing, though the database reorders every key.
  phone.applied.length = laptop.applied.length = 0;
  const before = copy(cloud.rows.get('u1'));
  assert.deepEqual((await phone.sync()).uploaded, []);
  assert.deepEqual((await laptop.sync()).uploaded, []);
  assert.deepEqual(phone.applied, []);
  assert.deepEqual(laptop.applied, []);
  assert.deepEqual(cloud.rows.get('u1'), before);
});

test('two devices that both ran the AI settle on one record instead of trading places', async () => {
  const cloud = makeCloud();
  const a = makeDevice(cloud), b = makeDevice(cloud);
  cloud.signUp('u1');
  a.store.save('traderState', account([['BTC', 1]], { startedAt: 200 }));
  b.store.save('traderState', account([['ETH', 5]], { startedAt: 100 }));   // running longer, on its own history
  a.session.id = b.session.id = 'u1';
  await a.sync();
  assert.deepEqual((await b.sync()).uploaded, ['traderState'], 'the AI account that has run longest is kept');
  await a.sync();
  assert.deepEqual(trades(a.store.load('traderState')), ['ETH:5']);

  // A new device whose AI ran by itself before signing in takes the account's record.
  const c = makeDevice(cloud);
  c.store.save('traderState', account([['DOGE', 7]], { startedAt: 300 }));
  c.session.id = 'u1';
  assert.deepEqual((await c.sync()).conflicts, ['traderState']);
  assert.deepEqual(trades(c.store.load('traderState')), ['ETH:5']);

  for (let round = 0; round < 4; round++) {
    a.store.save('traderState', aiStep(a.store.load('traderState'), 'a'));
    // in round 1 the second device sees different data and takes a different trade
    b.store.save('traderState', aiStep(b.store.load('traderState'), 'b', round === 1 ? 'DOGE' : 'SOL'));
    await a.sync();
    await b.sync();
    assert.deepEqual(trades(b.store.load('traderState')), trades(a.store.load('traderState')), `round ${round}: same trades on both`);
    assert.deepEqual(trades(cloud.rows.get('u1').trading.traderState), trades(a.store.load('traderState')));
  }
  for (const d of [a, b, c]) {
    assert.equal(backupFor(d.store.load, 'u1'), null, "the AI's replayed trades are never offered back as the user's own");
    assert.equal(d.store.load('syncBackup', null), null, 'nor kept');
  }

  // The first device closes; the second carries on and its checks now go up.
  b.store.save('traderState', aiStep(b.store.load('traderState'), 'b'));
  assert.deepEqual((await b.sync()).uploaded, ['traderState']);
  await a.sync();
  assert.deepEqual(trades(a.store.load('traderState')), trades(b.store.load('traderState')));
});

test('an AI account with no trades yet still reaches new devices and is never replaced by theirs', async () => {
  const cloud = makeCloud();
  const a = makeDevice(cloud), b = makeDevice(cloud), c = makeDevice(cloud);
  cloud.signUp('u1');
  a.session.id = b.session.id = c.session.id = 'u1';
  // Started on one device, chart changed, no trade yet.
  a.store.save('traderState', account([], { startedAt: 100, interval: '15m', log: [{ t: 150, kind: 'settings', text: 'chart 1h → 15m' }] }));
  await a.sync();
  // A device with nothing of its own takes it.
  await b.sync();
  assert.equal(b.store.load('traderState')?.interval, '15m', 'a new device gets the account');
  // A device whose AI started by itself before signing in, and already traded, keeps the account instead.
  c.store.save('traderState', account([['ETH', 9]], { startedAt: 500 }));
  const r = await c.sync();
  assert.deepEqual(r.uploaded, [], 'its own account does not go up');
  assert.equal(c.store.load('traderState')?.interval, '15m');
  assert.equal(cloud.rows.get('u1').trading.traderState.log[0].text, 'chart 1h → 15m', 'the settings change is still on the account');
});

test('two devices saving different accounts at the same moment keep both', async () => {
  const cloud = makeCloud();
  const a = makeDevice(cloud), b = makeDevice(cloud);
  cloud.signUp('u1');
  a.session.id = b.session.id = 'u1';
  a.store.save('myDemoState', account([['BTC', 1]]));
  b.store.save('realTradeState', account([['ETH', 2]]));
  // b reads the cloud, then a saves before b's save lands.
  b.net.beforePush = () => a.sync();
  await b.sync();
  const row = cloud.rows.get('u1');
  assert.deepEqual(trades(row.trading.myDemoState), ['BTC:1'], 'a\'s save survived b\'s');
  assert.deepEqual(trades(row.trading.realTradeState), ['ETH:2']);
  await a.sync();
  await b.sync();
  assert.deepEqual(trades(a.store.load('realTradeState')), ['ETH:2']);
  assert.deepEqual(trades(b.store.load('myDemoState')), ['BTC:1']);
});

test('an edit made while a save is on its way is not lost', async () => {
  const cloud = makeCloud();
  const d = makeDevice(cloud);
  cloud.signUp('u1');
  d.session.id = 'u1';
  d.store.save('myDemoState', account([['BTC', 1]]));
  d.net.beforePush = () => { d.store.save('myDemoState', account([['BTC', 1], ['ETH', 2]])); };
  await d.sync();
  assert.deepEqual(trades(d.store.load('myDemoState')), ['BTC:1', 'ETH:2'], 'the newer edit stays on the device');
  assert.deepEqual((await d.sync()).uploaded, ['myDemoState'], 'and goes up on the next sync');
  assert.deepEqual(trades(cloud.rows.get('u1').trading.myDemoState), ['BTC:1', 'ETH:2']);
});

test('a shared device never hands one account\'s data to another', async () => {
  const cloud = makeCloud();
  const d = makeDevice(cloud);
  cloud.signUp('alice');
  cloud.signUp('bob');
  d.session.id = 'alice';
  d.store.save('holdings', [{ symbol: 'BTC', qty: 3 }]);
  d.store.save('myDemoState', account([['BTC', 1]]));
  await d.sync();
  d.session.id = null;                       // Alice signs out
  d.session.id = 'bob';                      // Bob signs in on the same browser
  const r = await d.sync();
  assert.equal(r.foreign, true);
  assert.deepEqual(r.uploaded, []);
  const bob = cloud.rows.get('bob');
  assert.deepEqual(bob.holdings, [], 'Alice\'s holdings were not uploaded into Bob\'s account');
  assert.equal(bob.trading.myDemoState, undefined, 'nor her trades');
  assert.equal(d.store.load('holdings', null), null, 'and Bob does not see them');
  assert.equal(d.store.load('myDemoState', null), null);
  await d.sync();
  assert.deepEqual(cloud.rows.get('bob').holdings, []);

  d.session.id = 'alice';                    // Alice comes back: her data returns
  await d.sync();
  assert.deepEqual(d.store.load('holdings', null), [{ qty: 3, symbol: 'BTC' }]);
  assert.deepEqual(trades(d.store.load('myDemoState', null)), ['BTC:1']);
});

test('a device that loses its storage, or goes offline, loses nothing', async () => {
  const cloud = makeCloud();
  const a = makeDevice(cloud);
  cloud.signUp('u1');
  a.session.id = 'u1';
  a.store.save('watchlist', ['BTC', 'SOL']);
  a.store.save('traderState', account([['BTC', 1]]));
  await a.sync();

  const fresh = makeDevice(cloud);           // a new phone, or cleared browser data
  fresh.session.id = 'u1';
  await fresh.sync();
  assert.deepEqual(fresh.store.load('watchlist'), ['BTC', 'SOL']);
  assert.deepEqual(trades(fresh.store.load('traderState')), ['BTC:1']);

  a.net.offline = true;
  a.store.save('watchlist', ['BTC', 'SOL', 'XRP']);
  await assert.rejects(a.sync(), /offline/);
  assert.deepEqual(a.store.load('watchlist'), ['BTC', 'SOL', 'XRP'], 'the offline edit stays');
  a.net.offline = false;
  await a.sync();
  assert.deepEqual(cloud.rows.get('u1').watchlist, ['BTC', 'SOL', 'XRP'], 'and goes up once back online');
});

test('only the account settings travel; a device\'s own API key never leaves it', async () => {
  const cloud = makeCloud();
  const d = makeDevice(cloud);
  cloud.signUp('u1');
  d.session.id = 'u1';
  d.settings.set({ theme: 'light', customKey: 'sk-private', lang: 'ur' });
  await d.sync();
  const s = cloud.rows.get('u1').settings;
  assert.equal(s.theme, 'light');
  assert.equal(s.lang, 'ur');
  assert.equal('customKey' in s, false);
});

test('a trade you recorded on two devices at once is set aside and can be put back', async () => {
  const cloud = makeCloud();
  const a = makeDevice(cloud), b = makeDevice(cloud);
  cloud.signUp('u1');
  a.session.id = b.session.id = 'u1';
  a.store.save('realTradeState', account([['BTC', 1]]));
  await a.sync();
  await b.sync();
  a.store.save('realTradeState', account([['BTC', 1], ['ETH', 2]]));   // both record a trade before either syncs
  b.store.save('realTradeState', account([['BTC', 1], ['XRP', 3]]));
  await a.sync();
  const r = await b.sync();
  assert.deepEqual(r.conflicts, ['realTradeState']);
  assert.deepEqual(trades(b.store.load('realTradeState')), ['BTC:1', 'ETH:2'], 'the account\'s copy is shown');
  assert.deepEqual(trades(backupFor(b.store.load, 'u1').keys.realTradeState), ['BTC:1', 'XRP:3'], 'this device\'s copy is kept');
  // A second clash before the user decides keeps the first copy offered.
  a.store.save('realTradeState', account([['BTC', 1], ['ETH', 2], ['ADA', 4]]));
  b.store.save('realTradeState', account([['BTC', 1], ['ETH', 2], ['SOL', 5]]));
  await a.sync();
  await b.sync();
  assert.deepEqual(trades(backupFor(b.store.load, 'u1').keys.realTradeState), ['BTC:1', 'XRP:3']);
  assert.deepEqual(restoreBackup(b.store, 'u1'), ['realTradeState']);
  assert.equal(backupFor(b.store.load, 'u1'), null);
  assert.deepEqual((await b.sync()).uploaded, ['realTradeState'], 'putting it back sends it up');
  await a.sync();
  assert.deepEqual(trades(a.store.load('realTradeState')), ['BTC:1', 'XRP:3'], 'the put-back copy reaches the other device');
});

test('only trades this device alone had count as lost', () => {
  const mine = account([['BTC', 1], ['ETH', 2]]);
  mine.open = { SOL: { symbol: 'SOL', openedAt: 3 } };
  assert.deepEqual(missingTrades(mine, account([['BTC', 1]])), ['SOL:3', 'ETH:2']);
  assert.deepEqual(missingTrades(account([['BTC', 1]]), mine), []);
});
