// The exchange's clock, not the device's.
//
// A laptop whose clock is a few minutes out makes every "3 minutes ago" wrong,
// mislabels a live candle as stale, and shifts the forecast horizon. Binance
// publishes its server time, so the app measures the difference once, corrects
// for the round trip, and uses the corrected clock everywhere a timestamp is
// compared against "now".
let offsetMs = 0;      // serverTime − deviceTime
let measuredAt = 0;
let syncing = null;

export const clockOffsetMs = () => offsetMs;
export const clockChecked = () => measuredAt;

/** Current time, corrected to the exchange's clock. */
export const now = () => Date.now() + offsetMs;

export async function syncClock(fetchJson) {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const t0 = Date.now();
      const r = await fetchJson();
      const t1 = Date.now();
      // Assume the request and the reply took the same time, so the server's
      // clock reading lines up with the midpoint of our own two readings.
      const midpoint = t0 + (t1 - t0) / 2;
      if (r && Number.isFinite(+r.serverTime)) {
        offsetMs = Math.round(+r.serverTime - midpoint);
        measuredAt = Date.now();
      }
    } catch { /* keep the device clock */ }
    syncing = null;
    return offsetMs;
  })();
  return syncing;
}
