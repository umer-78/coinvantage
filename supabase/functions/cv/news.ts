// Scheduled news collector: reads public crypto RSS feeds and caches headlines with coin tags.
import { admin, json, requireCron, sha256Hex } from './lib.ts';

const FEEDS = [
  ['Cointelegraph', 'https://cointelegraph.com/rss'],
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['Decrypt', 'https://decrypt.co/feed'],
  ['Bitcoin Magazine', 'https://bitcoinmagazine.com/.rss/full/'],
  ['The Block', 'https://www.theblock.co/rss.xml'],
];

const COINS: [string, string[]][] = [
  ['BTC', ['bitcoin', 'btc']], ['ETH', ['ethereum', 'ether', 'eth']], ['SOL', ['solana', 'sol']], ['BNB', ['bnb', 'binance coin']],
  ['XRP', ['xrp', 'ripple']], ['DOGE', ['dogecoin', 'doge']], ['ADA', ['cardano', 'ada']], ['TRX', ['tron', 'trx']],
  ['AVAX', ['avalanche', 'avax']], ['LINK', ['chainlink', 'link']], ['DOT', ['polkadot', 'dot']], ['TON', ['toncoin', 'ton']],
  ['LTC', ['litecoin', 'ltc']], ['SHIB', ['shiba inu', 'shib']], ['BCH', ['bitcoin cash', 'bch']], ['NEAR', ['near protocol']],
  ['SUI', ['sui']], ['APT', ['aptos']], ['UNI', ['uniswap']], ['PEPE', ['pepe']], ['ARB', ['arbitrum']], ['OP', ['optimism']],
  ['USDT', ['tether', 'usdt']], ['USDC', ['usdc', 'circle']], ['XLM', ['stellar', 'xlm']], ['HBAR', ['hedera', 'hbar']],
  ['ATOM', ['cosmos', 'atom']], ['AAVE', ['aave']], ['FIL', ['filecoin']], ['ICP', ['internet computer']], ['RENDER', ['render']],
  ['INJ', ['injective']], ['TAO', ['bittensor']], ['HYPE', ['hyperliquid']], ['ENA', ['ethena']], ['ONDO', ['ondo']],
];

const pick = (xml: string, tag: string) => {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim() : '';
};
const decode = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#8217;|&rsquo;/g, "'").replace(/&#8216;|&lsquo;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&#8230;/g, '…').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

function tagCoins(text: string) {
  const lower = ` ${text.toLowerCase()} `;
  const found: string[] = [];
  for (const [sym, names] of COINS) {
    const hit = names.some((n) => n.length <= 4
      ? new RegExp(`(^|[^a-z0-9$])\\$?${n}([^a-z0-9]|$)`).test(lower) && new RegExp(`\\b${n.toUpperCase()}\\b`).test(text)
      : lower.includes(n));
    if (hit) found.push(sym);
  }
  return found.slice(0, 6);
}

export async function newsFetch(req: Request): Promise<Response> {
  await requireCron(req);
  const rows: Record<string, unknown>[] = [];
  const report: Record<string, number | string> = {};
  await Promise.all(FEEDS.map(async ([source, url]) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 CoinVantage news reader' } });
      clearTimeout(t);
      const xml = await res.text();
      const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].slice(0, 25);
      for (const [item] of items) {
        const title = decode(pick(item, 'title'));
        let link = decode(pick(item, 'link'));
        if (!link) link = /<guid[^>]*>(https?:[^<]+)<\/guid>/i.exec(item)?.[1] || '';
        if (!title || !link.startsWith('http')) continue;
        const pub = new Date(pick(item, 'pubDate') || pick(item, 'dc:date') || Date.now());
        const rawDesc = pick(item, 'description') || pick(item, 'content:encoded');
        const summary = decode(rawDesc).slice(0, 320);
        const image = /<media:content[^>]+url="([^"]+)"/i.exec(item)?.[1] || /<media:thumbnail[^>]+url="([^"]+)"/i.exec(item)?.[1]
          || /<enclosure[^>]+url="([^"]+)"/i.exec(item)?.[1] || /<img[^>]+src="([^"]+)"/i.exec(rawDesc.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))?.[1] || null;
        rows.push({
          id: (await sha256Hex(link)).slice(0, 32), source, title: title.slice(0, 300), link: link.slice(0, 500), summary, image: image?.startsWith('https') ? image : null,
          coins: tagCoins(`${title} ${summary}`), published_at: isNaN(pub.getTime()) ? new Date().toISOString() : pub.toISOString(),
        });
      }
      report[source] = items.length;
    } catch (e) {
      report[source] = `error: ${(e as Error).message}`;
    }
  }));
  if (rows.length) {
    const { error } = await admin.from('news').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
  }
  await admin.from('news').delete().lt('published_at', new Date(Date.now() - 10 * 864e5).toISOString());
  return json({ saved: rows.length, report });
}
