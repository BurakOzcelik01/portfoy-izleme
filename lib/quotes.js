// BIST ve ABD fiyatlarını Yahoo Finance'ten alır. Yahoo'ya yalnızca hisse kodları gider.
const CACHE_MS = 30_000;
const cache = new Map();

/** Geçici bir hatadan farklı olarak, sorulan kodun gerçekten olmadığını anlatır. */
class SymbolNotFound extends Error {}

async function fetchQuote(yahooSymbol, currency, fetchImpl = fetch) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) throw new SymbolNotFound(`${yahooSymbol} bulunamadı`);
  if (!response.ok) throw new Error(`Yahoo ${response.status}`);
  const body = await response.json();
  const meta = body?.chart?.result?.[0]?.meta;
  if (typeof meta?.regularMarketPrice !== 'number') throw new SymbolNotFound('Fiyat bulunamadı');
  if (meta.currency !== currency) throw new SymbolNotFound(`Beklenmeyen para birimi: ${meta.currency}`);
  const previous = meta.chartPreviousClose ?? meta.previousClose;
  return {
    price: meta.regularMarketPrice,
    changePercent:
      meta.regularMarketChangePercent ??
      (typeof previous === 'number' && previous > 0 ? ((meta.regularMarketPrice - previous) / previous) * 100 : null),
    marketTime: typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : null,
  };
}

/**
 * Fiyat alınamazsa son bilinen fiyat `stale: true` ile döner; hiç fiyat yoksa
 * `price: null` döner. Toplamlar sessizce sıfır fiyatla hesaplanmasın diye.
 */
async function getQuote(yahooSymbol, currency) {
  const cached = cache.get(yahooSymbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.quote;
  try {
    const quote = { ...(await fetchQuote(yahooSymbol, currency)), stale: false };
    cache.set(yahooSymbol, { quote, fetchedAt: Date.now() });
    return quote;
  } catch (error) {
    if (cached) return { ...cached.quote, stale: true };
    return { price: null, changePercent: null, marketTime: null, stale: true, error: error.message };
  }
}

/**
 * Kodun o piyasada işlem gören bir hisse olup olmadığını söyler.
 * Yahoo'ya ulaşılamazsa hata fırlatır: geçici bir sorun "böyle bir hisse yok" sayılmaz.
 */
export async function symbolExists(symbol, market, fetchImpl = fetch) {
  const [yahooSymbol, currency] = market === 'US' ? [symbol, 'USD'] : [`${symbol}.IS`, 'TRY'];
  try {
    await fetchQuote(yahooSymbol, currency, fetchImpl);
    return true;
  } catch (error) {
    if (error instanceof SymbolNotFound) return false;
    throw error;
  }
}

/** @returns {{quotes: object[], usdTry: number|null}} usdTry, 1 doların TL karşılığıdır. */
export async function getQuotes(holdings) {
  const quotes = await Promise.all(
    holdings.map(async ({ symbol, market }) => ({
      symbol,
      market,
      ...(market === 'US' ? await getQuote(symbol, 'USD') : await getQuote(`${symbol}.IS`, 'TRY')),
    })),
  );
  const usdTry = holdings.some((h) => h.market === 'US') ? (await getQuote('USDTRY=X', 'TRY')).price : null;
  return { quotes, usdTry };
}
