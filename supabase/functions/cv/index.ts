// CoinVantage backend: one edge function, routed by path.
//   /cv/account        public + signed-in user actions
//   /cv/admin          admin panel actions
//   /cv/alerts-check   cron (every minute)
//   /cv/track-signals  cron (track record)
//   /cv/news-fetch     cron (RSS news)
//   /cv/telegram       Telegram bot webhook
//   /cv/stripe         Stripe webhook
//   /cv/selftest       engine integrity check (deterministic output)
import { handle, json, HttpError } from './lib.ts';
import { account } from './account.ts';
import { adminApi } from './admin.ts';
import { alertsCheck } from './alerts.ts';
import { trackSignals } from './track.ts';
import { newsFetch } from './news.ts';
import { telegramBot } from './telegram.ts';
import { stripeWebhook } from './stripe.ts';
import { generateSignal } from './engine/signals.js';
import { forecast } from './engine/predict.js';

const routes: Record<string, (req: Request) => Promise<Response>> = {
  account, admin: adminApi, 'alerts-check': alertsCheck, 'track-signals': trackSignals,
  'news-fetch': newsFetch, telegram: telegramBot, stripe: stripeWebhook,
  selftest: async () => {
    const candles = Array.from({ length: 400 }, (_, i) => {
      const c = 100 + Math.sin(i / 9) * 8 + Math.sin(i / 37) * 15 + i * 0.05;
      return { t: i * 3600e3, o: c - Math.cos(i / 5) * 0.6, h: c + 1.2, l: c - 1.3, c, v: 1000 + (i % 17) * 40 };
    });
    const s = generateSignal(candles, { interval: '1h' });
    const f = forecast(candles, { horizon: 6, fast: true });
    return json({ score: s.score, action: s.action, probUp: f.ok ? +f.probUp.toFixed(6) : null, acc: f.ok ? f.ensemble.accuracy : null });
  },
};

Deno.serve(handle(async (req) => {
  const name = new URL(req.url).pathname.split('/').filter(Boolean).pop() || '';
  const fn = routes[name];
  if (!fn) throw new HttpError('Not found', 404);
  return fn(req);
}));
