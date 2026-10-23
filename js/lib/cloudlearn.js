// The AI's learning record as the cloud keeps it: a server job grades every
// indicator, the forecast and the learned blend on the coins with Binance
// candles, on every chart, every five minutes, with every browser closed
// (supabase/functions/cv/learnjob.js). The AI learning page, the coin page and
// the Trading page read its summaries. When it cannot be read (no backend, or
// offline) they fall back to a learning pass in this browser.
import { getCloudLearning } from '../api/backend.js';

const FRESH = 60e3;
// A page waits at most this long for the record: a slow link to the cloud must
// not hold up the coin page's forecast or the learning page.
const WAIT_MS = 4000;
let cache = null, inflight = null;

/** Every chart's summary ({ '1h': {...}, ... }), or null. Read at most once a minute. */
export function cloudLearning({ force = false, read = getCloudLearning } = {}) {
  if (!force && cache && Date.now() - cache.at < FRESH) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), WAIT_MS));
  inflight = Promise.race([Promise.resolve().then(read).catch(() => null), timeout]).then((data) => {
    inflight = null;
    // a failed read keeps the last good copy
    if (data && Object.keys(data).length) cache = { at: Date.now(), data };
    return cache?.data || null;
  });
  return inflight;
}

/** The copy last read, without waiting for a new one. */
export const cloudLearningNow = () => cache?.data || null;
