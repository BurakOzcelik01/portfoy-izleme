// Fon fiyatlarını TEFAS'tan alır. Adres resmî olarak belgelenmemiştir, değişirse burası güncellenmelidir.
// Tek istekte tüm fonlar gelir: TEFAS'ın dakikalık istek sınırına takılmamak için fon başına sorgu atılmaz.
const URL_INFO = 'https://www.tefas.gov.tr/api/funds/fonGnlBlgSiraliGetir';
const LOOKBACK_DAYS = 7;

const compact = (date) => date.replaceAll('-', '');

function daysBefore(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
}

/** @returns {Promise<Map<string, {date: string, price: number}[]>>} koda göre, yeniden eskiye fiyatlar */
export async function fetchFundPrices(today, fetchImpl = fetch) {
  const response = await fetchImpl(URL_INFO, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'portfoy-izleme/0.1' },
    body: JSON.stringify({
      fonTipi: 'YAT', fonKodu: null, aramaMetni: null, fonTurKod: null, fonGrubu: null, sfonTurKod: null,
      fonTurAciklama: null, kurucuKod: null,
      basTarih: compact(daysBefore(today, LOOKBACK_DAYS)), bitTarih: compact(today),
      basSira: 1, bitSira: 100000, dil: 'TR', sFonTurKod: '', fonKod: '', fonGrup: '', fonUnvanTip: '',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`TEFAS ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.resultList)) throw new Error(body?.errorMessage ?? 'TEFAS beklenmeyen yanıt verdi');

  const prices = new Map();
  for (const row of body.resultList) {
    if (typeof row.fiyat !== 'number' || row.fiyat <= 0) continue;
    if (!prices.has(row.fonKodu)) prices.set(row.fonKodu, []);
    prices.get(row.fonKodu).push({ date: row.tarih.slice(0, 10), price: row.fiyat });
  }
  for (const list of prices.values()) list.sort((a, b) => b.date.localeCompare(a.date));
  return prices;
}
