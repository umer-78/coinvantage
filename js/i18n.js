// Minimal i18n: English strings are the keys, so anything not translated
// falls back to English automatically. Add languages by adding a dictionary.
import { settings } from './store.js';

const UR = {
  // navigation & shell
  'Markets': 'مارکیٹس',
  'Market scan': 'مارکیٹ اسکین',
  'Scan': 'اسکین',
  'Ask': 'پوچھیں',
  'Assistant': 'اسسٹنٹ',
  'Trading': 'ٹریڈنگ',
  'Scanner': 'اسکینر',
  'Record': 'ریکارڈ',
  'Tools': 'ٹولز',
  'Alerts': 'الرٹس',
  'AI Assistant': 'اے آئی اسسٹنٹ',
  'Signal Scanner': 'سگنل اسکینر',
  'Compare': 'موازنہ',
  'Exchanges': 'ایکسچینجز',
  'Wallet': 'والٹ',
  'Price Alerts': 'قیمت الرٹس',
  'Track record': 'کارکردگی ریکارڈ',
  'News': 'خبریں',
  'Futures': 'فیوچرز',
  'Premium': 'پریمیم',
  'Account': 'اکاؤنٹ',
  'Admin': 'ایڈمن',
  'Sign in': 'سائن ان',
  'Sign up': 'اکاؤنٹ بنائیں',
  'Sign out': 'سائن آؤٹ',
  'Search coin (BTC, Ethereum…)': 'کوائن تلاش کریں (BTC، Ethereum…)',
  'More': 'مزید',
  'Menu': 'مینیو',
  'Language': 'زبان',
  'Currency': 'کرنسی',
  'Live · Binance stream': 'لائیو · بائنانس اسٹریم',
  'Paused while the tab is in the background': 'ٹیب پس منظر میں ہونے پر روکا گیا',
  'Reconnecting…': 'دوبارہ جڑ رہا ہے…',
  // common words
  'Price': 'قیمت',
  'Coin': 'کوائن',
  'Signal': 'سگنل',
  'Score': 'اسکور',
  'Buy': 'خریدیں',
  'Sell': 'بیچیں',
  'Neutral': 'غیر جانبدار',
  'Strong Buy': 'مضبوط خریداری',
  'Strong Sell': 'مضبوط فروخت',
  'Market cap': 'مارکیٹ کیپ',
  'Volume 24h': '24 گھنٹے والیوم',
  'Entry zone': 'داخلے کی حد',
  'Stop-loss': 'اسٹاپ لاس',
  'Take-profit 1': 'ٹیک پرافٹ 1',
  'Trade signal': 'ٹریڈ سگنل',
  'AI forecast': 'اے آئی پیش گوئی',
  'Chance of rise': 'اوپر جانے کا امکان',
  'Expected move': 'متوقع تبدیلی',
  'Target': 'ہدف',
  'High confidence': 'زیادہ اعتماد',
  'Moderate confidence': 'درمیانہ اعتماد',
  'Low confidence': 'کم اعتماد',
  'Pattern comparison': 'پیٹرن موازنہ',
  'History & cycles': 'تاریخ اور سائیکل',
  'Backtest': 'بیک ٹیسٹ',
  'Order book': 'آرڈر بک',
  'About': 'تعارف',
  'Not financial advice.': 'یہ مالی مشورہ نہیں ہے۔',
  'Loading…': 'لوڈ ہو رہا ہے…',
  'Save': 'محفوظ کریں',
  'Cancel': 'منسوخ',
  'Delete': 'حذف کریں',
  'Add': 'شامل کریں',
  'Close': 'بند کریں',
  'Email': 'ای میل',
  'Password': 'پاس ورڈ',
  'Name': 'نام',
  'Yes': 'ہاں',
  'No': 'نہیں',
  // pages
  'Crypto prices today': 'آج کی کرپٹو قیمتیں',
  'Total market cap': 'کل مارکیٹ کیپ',
  'BTC dominance': 'بی ٹی سی غلبہ',
  'Fear & Greed': 'خوف اور لالچ',
  'Trending': 'ٹرینڈنگ',
  'Top gainers 24h': '24 گھنٹے میں سب سے زیادہ بڑھنے والے',
  'Top losers 24h': '24 گھنٹے میں سب سے زیادہ گرنے والے',
  'All coins': 'تمام کوائنز',
  'Watchlist': 'واچ لسٹ',
  'Table': 'ٹیبل',
  'Heatmap': 'ہیٹ میپ',
  'Wallet & portfolio': 'والٹ اور پورٹ فولیو',
  'Holdings': 'ہولڈنگز',
  'Add holding': 'ہولڈنگ شامل کریں',
  'Allocation': 'تقسیم',
  'Portfolio value': 'پورٹ فولیو ویلیو',
  'Total profit / loss': 'کل نفع / نقصان',
  '24h change': '24 گھنٹے کی تبدیلی',
  'New alert': 'نیا الرٹ',
  'Your alerts': 'آپ کے الرٹس',
  'Create alert': 'الرٹ بنائیں',
  'Above': 'سے اوپر',
  'Below': 'سے نیچے',
  'Signal track record': 'سگنل کارکردگی ریکارڈ',
  'Crypto news': 'کرپٹو خبریں',
  'Futures & derivatives': 'فیوچرز اور ڈیریویٹوز',
  'Funding rate': 'فنڈنگ ریٹ',
  'Open interest': 'اوپن انٹرسٹ',
  'Liquidations': 'لیکویڈیشنز',
  'Long': 'لانگ',
  'Short': 'شارٹ',
  'Terms of Service': 'شرائط و ضوابط',
  'Privacy Policy': 'پرائیویسی پالیسی',
  'Risk Disclosure': 'خطرات کا انکشاف',
  'I understand': 'میں سمجھ گیا',
  'Upgrade to Premium': 'پریمیم حاصل کریں',
  'Premium members only': 'صرف پریمیم ممبران کے لیے',
  'Telegram alerts': 'ٹیلیگرام الرٹس',
  'Connect Telegram': 'ٹیلیگرام جوڑیں',
  'Signed in as': 'بطور سائن ان',
  'Create your account': 'اپنا اکاؤنٹ بنائیں',
  'Welcome back': 'خوش آمدید',
};

const DICTS = { ur: UR };

// Pinned to English while the switcher is out of the header. The translations
// below only ever covered the navigation, so a stored 'ur' would otherwise
// leave a returning visitor in a half-translated, right-to-left UI with no
// control left on screen to change it back. Restore `settings.get().lang` here
// when the page content is genuinely translated.
export const I18N = { lang: 'en' };

export function t(text, vars) {
  let out = DICTS[I18N.lang]?.[text] || text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

export function setLang(code) {
  I18N.lang = (DICTS[code] || code === 'en') ? code : 'en';
  settings.set({ lang: I18N.lang });
  applyDir();
  window.dispatchEvent(new CustomEvent('cv:lang', { detail: { lang: I18N.lang } }));
}

export function applyDir() {
  document.documentElement.lang = I18N.lang;
  document.documentElement.dir = I18N.lang === 'ur' ? 'rtl' : 'ltr';
}
