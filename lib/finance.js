// Saf hesap mantığı: dosya, ağ veya saat erişimi yok; "bugün" dışarıdan verilir.
import { randomUUID } from 'node:crypto';

export function todayInIstanbul(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(now);
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Ayın 31'i gibi günler kısa aylarda ayın son gününe çekilir.
function dateInMonth(year, month, day) {
  const clamped = Math.min(day, lastDayOfMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

/** `date`ten kesinlikle sonraki ilk "ayın X'i" tarihi. */
export function nextOccurrenceAfter(date, day) {
  let [year, month] = date.split('-').map(Number);
  let candidate = dateInMonth(year, month, day);
  if (candidate <= date) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    candidate = dateInMonth(year, month, day);
  }
  return candidate;
}

/** `date`e eşit veya sonraki ilk "ayın X'i" tarihi (kart tarihleri için). */
export function nextOccurrenceOnOrAfter(date, day) {
  const [year, month] = date.split('-').map(Number);
  const candidate = dateInMonth(year, month, day);
  return candidate >= date ? candidate : nextOccurrenceAfter(date, day);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Vadesi gelmiş gelirleri hesaba işler. Uygulama günlerce kapalı kalsa bile
 * kaçırılan aylar tek tek eklenir; nextDate ilerlediği için aynı gelir iki kez yatmaz.
 */
export function applyDueIncomes(state, today) {
  const applied = [];
  for (const income of state.incomes) {
    const account = state.accounts.find((a) => a.id === income.accountId);
    if (!account) continue;
    while (income.nextDate <= today) {
      account.balance = round2(account.balance + income.amount);
      const entry = {
        id: randomUUID(),
        date: income.nextDate,
        text: `${income.name} geliri ${account.name} hesabına eklendi`,
        amount: income.amount,
      };
      state.activity.unshift(entry);
      applied.push(entry);
      income.nextDate = nextOccurrenceAfter(income.nextDate, income.day);
    }
  }
  return applied;
}

/** Vadesi gelmiş sabit giderleri hesaptan düşer; işleyişi gelirlerle aynıdır. */
export function applyDueExpenses(state, today) {
  const applied = [];
  for (const expense of state.expenses) {
    const account = state.accounts.find((a) => a.id === expense.accountId);
    if (!account) continue;
    while (expense.nextDate <= today) {
      account.balance = round2(account.balance - expense.amount);
      const entry = {
        id: randomUUID(),
        date: expense.nextDate,
        text: `${expense.name} gideri ${account.name} hesabından düşüldü`,
        amount: -expense.amount,
      };
      state.activity.unshift(entry);
      applied.push(entry);
      expense.nextDate = nextOccurrenceAfter(expense.nextDate, expense.day);
    }
  }
  return applied;
}

export const GRAMS_PER_OUNCE = 31.1034768;

/** Bir altın kaydının TL değeri. Gram TL, ons dolar üzerinden fiyatlanır. Fiyat yoksa null. */
export function goldValueTry(lot, ounceUsd, usdTry) {
  if (ounceUsd == null || usdTry == null) return null;
  const perUnit = lot.kind === 'ons' ? ounceUsd * usdTry : (ounceUsd * usdTry) / GRAMS_PER_OUNCE;
  return lot.quantity * perUnit;
}

/**
 * Net varlık ve parçaları. Fiyatı alınamayan hisse ve altınlar toplama girmez, `missing` ile sayılır.
 * @param {{quotes: {symbol: string, market: string, price: number|null}[], usdTry: number|null, goldOunceUsd: number|null}} market
 */
export function computeTotals(state, market, today) {
  const quoteOf = (h) => market.quotes.find((q) => q.symbol === h.symbol && q.market === h.market);
  // Yalnızca seansı gerçekten bugün olan değişim sayılır. Seans günü borsanın kendi saatine göredir:
  // ABD'nin Perşembe kapanışı İstanbul'da Cuma 00:00'dır ama Cuma'nın kazancı değildir.
  const sessionIsToday = (time, timeZone) =>
    time != null && new Intl.DateTimeFormat('en-CA', { timeZone }).format(time) === today;
  // Bir değerin bugünkü kazancı: değer − önceki kapanıştaki değer.
  const gainOf = (value, changePercent, time, timeZone) => (
    changePercent == null || !sessionIsToday(time, timeZone) ? 0 : value - value / (1 + changePercent / 100)
  );
  let stocks = 0;
  let gold = 0;
  let missing = 0;
  let daily = 0;
  for (const holding of state.holdings) {
    const quote = quoteOf(holding);
    const rate = holding.market === 'US' ? market.usdTry : 1;
    if (quote?.price == null || rate == null) {
      missing += 1;
    } else {
      const value = holding.quantity * quote.price * rate;
      stocks += value;
      const timeZone = holding.market === 'US' ? 'America/New_York' : 'Europe/Istanbul';
      daily += gainOf(value, quote.changePercent, quote.marketTime, timeZone);
    }
  }
  for (const lot of state.gold) {
    const value = goldValueTry(lot, market.goldOunceUsd, market.usdTry);
    if (value === null) {
      missing += 1;
    } else {
      gold += value;
      daily += gainOf(value, market.goldChangePercent, market.goldMarketTime, 'Europe/Istanbul');
    }
  }
  for (const fund of state.funds) {
    if (fund.priceDate === today && fund.units != null && fund.price != null && fund.prevPrice != null) {
      daily += fund.units * (fund.price - fund.prevPrice);
    }
  }
  const cash = state.accounts.reduce((sum, a) => sum + a.balance, 0);
  const funds = state.funds.reduce((sum, f) => sum + f.value, 0);
  const debt = state.cards.reduce((sum, c) => sum + c.debt, 0);
  // Yüzde, fiyatı değişen varlıklara göredir: banka bakiyesi ve kart borcu günlük hareket etmez.
  const previousInvested = stocks + gold + funds - daily;
  return {
    dailyChange: round2(daily),
    dailyPercent: previousInvested > 0 ? (daily / previousInvested) * 100 : null,
    cash: round2(cash),
    stocks: round2(stocks),
    funds: round2(funds),
    moneyMarket: moneyMarketTotal(state),
    gold: round2(gold),
    debt: round2(debt),
    net: round2(cash + stocks + funds + gold - debt),
    missing,
  };
}

/**
 * Günün net varlığını geçmişe yazar, gün içinde en son değerle günceller.
 * Eksik fiyatlı bir toplam grafikte sahte düşüş göstereceği için kaydedilmez.
 * @returns {boolean} kayıt değiştiyse true
 */
export function recordSnapshot(state, today, totals) {
  if (totals.missing > 0) return false;
  const { net, stocks, funds, gold, cash, debt } = totals;
  const last = state.history.at(-1);
  if (last?.date === today) {
    if (last.net === net) return false;
    Object.assign(last, { net, stocks, funds, gold, cash, debt });
  } else {
    state.history.push({ date: today, net, stocks, funds, gold, cash, debt });
  }
  return true;
}

/**
 * Dosyadan gelen veriyi güncel biçime getirir: eski dosyalarda olmayan alanlar eklenir, bursların
 * eski adı taşınır. Yedek dosyası bozuksa hata fırlatır.
 */
export function normalizeState(raw) {
  const isList = (value) => value === undefined || Array.isArray(value);
  const lists = ['accounts', 'cards', 'holdings', 'funds', 'incomes', 'scholarships', 'expenses', 'trades', 'gold', 'history', 'notes', 'activity'];
  if (raw === null || typeof raw !== 'object' || !lists.every((key) => isList(raw[key])) || !Array.isArray(raw.accounts)) {
    throw new Error('Veri dosyası geçersiz');
  }
  const { scholarships, ...rest } = raw;
  return {
    ...emptyState(),
    ...rest,
    incomes: rest.incomes ?? scholarships ?? [],
    holdings: (rest.holdings ?? []).map((h) => ({ market: 'BIST', ...h })),
    // Para piyasası toplamı fonlardan hesaplanır; eski dosyadaki elle girilmiş toplam atılır.
    moneyMarket: { buckets: rest.moneyMarket?.buckets ?? [] },
  };
}

export function allocatedTotal(state) {
  return round2(state.moneyMarket.buckets.reduce((sum, b) => sum + b.amount, 0));
}

function requireNumber(value, label, { min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`${label} geçerli bir sayı olmalı`);
  }
  return round2(value);
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} boş olamaz`);
  return value.trim();
}

function requireDay(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 31) {
    throw new Error(`${label} 1 ile 31 arasında olmalı`);
  }
  return value;
}

export function normalizeMarket(value) {
  const market = value ?? 'BIST';
  if (market !== 'BIST' && market !== 'US') throw new Error(`Bilinmeyen piyasa: ${market}`);
  return market;
}

export function normalizeSymbol(value, market) {
  // Borsa kodları Latin harflidir: Türkçe kuralıyla çevirmek "bimas"ı "BİMAS" yapardı.
  const upper = requireText(value, 'Hisse kodu').toUpperCase().replace(/İ/g, 'I');
  const symbol = market === 'BIST' ? upper.replace(/\.IS$/, '') : upper;
  const pattern = market === 'BIST' ? /^[A-Z0-9]{2,8}$/ : /^[A-Z0-9-]{1,8}$/;
  if (!pattern.test(symbol)) throw new Error(`Geçersiz hisse kodu: ${symbol}`);
  return symbol;
}

// ABD hisseleri küsuratlı alınabildiği için adet 2 haneye yuvarlanmaz.
function requireQuantity(value, label) {
  requireNumber(value, label);
  return Math.round(value * 1e9) / 1e9;
}

// "IOO" ile "ioo" gibi yazımlar aynı kayıt sayılsın diye ı/i farkı yok sayılır.
function nameKey(name) {
  return name.toLocaleLowerCase('tr-TR').replace(/ı/g, 'i');
}

function findByName(list, name, label) {
  const wanted = nameKey(requireText(name, label));
  return list.find((item) => nameKey(item.name) === wanted);
}

/** Para piyasası toplamı elle girilmez: para piyasası olarak işaretli fonların toplamıdır. */
export function moneyMarketTotal(state) {
  return round2(state.funds.filter((f) => f.moneyMarket).reduce((sum, f) => sum + f.value, 0));
}

function checkMoneyMarket(state) {
  if (allocatedTotal(state) > moneyMarketTotal(state)) {
    throw new Error(
      `Ayrılan toplam (${allocatedTotal(state)} TL), para piyasası tutarını (${moneyMarketTotal(state)} TL) aşıyor`,
    );
  }
}

// Fon payları tam sayıdır; fiyat yuvarlaması yüzünden çıkan küçük farkı temizler.
function unitsFrom(value, price) {
  const units = value / price;
  return Math.abs(units - Math.round(units)) < 0.01 ? Math.round(units) : Math.round(units * 1e6) / 1e6;
}

/**
 * TEFAS fiyatlarını fonlara işler. Pay adedi bilinmeyen fonda adet, girilen değer ile o günkü
 * fiyattan bir kez çıkarılır. TEFAS'ta olmayan kayıtlar (elle girilen satırlar) olduğu gibi kalır.
 * Para piyasası fonlarının fiyat farkı ayırmalara dağıtılır, ayrılmamış kısım değişmez.
 * @param {Map<string, {date: string, price: number}[]>} prices koda göre, yeniden eskiye fiyatlar
 * @returns {boolean} bir şey değiştiyse true
 */
export function applyFundPrices(state, prices) {
  const moneyMarketBefore = moneyMarketTotal(state);
  let changed = false;
  for (const fund of state.funds) {
    const list = prices.get(fund.name.toUpperCase().replace(/İ/g, 'I'));
    if (!list?.length) continue;
    const [latest, previous] = list;
    // Önceki fiyat günlük kâr/zarar içindir; değer bugün güncellenmiş olsa bile eksikse tamamlanır.
    if (previous && fund.prevPrice !== previous.price) {
      fund.prevPrice = previous.price;
      changed = true;
    }
    if (fund.units == null) {
      const reference = list.find((p) => p.date <= fund.updatedAt);
      if (!reference) continue;
      fund.units = unitsFrom(fund.value, reference.price);
    } else if (fund.priceDate === latest.date) {
      continue;
    }
    fund.value = round2(fund.units * latest.price);
    fund.price = latest.price;
    fund.priceDate = latest.date;
    fund.updatedAt = latest.date;
    changed = true;
  }
  const dates = state.funds.filter((f) => f.moneyMarket && f.priceDate).map((f) => f.priceDate).sort();
  distributeReturn(state, round2(moneyMarketTotal(state) - moneyMarketBefore), dates.at(-1));
  return changed;
}

/**
 * Getiriyi ayırmalara tutarlarıyla orantılı dağıtır. Kuruş yuvarlamasından kalan en büyük
 * ayırmaya eklenir, böylece dağıtılan toplam getiriye tam eşit olur. Ayırma yoksa getiri
 * ayrılmamış kısımda kalır.
 */
function distributeReturn(state, amount, date) {
  const { buckets } = state.moneyMarket;
  const allocated = allocatedTotal(state);
  if (amount === 0 || allocated <= 0) return;
  const cents = Math.round(amount * 100);
  const shares = buckets.map((b) => Math.round((cents * b.amount) / allocated));
  const largest = buckets.reduce((best, b, i) => (b.amount > buckets[best].amount ? i : best), 0);
  shares[largest] += cents - shares.reduce((sum, share) => sum + share, 0);
  buckets.forEach((bucket, i) => {
    bucket.amount = round2(bucket.amount + shares[i] / 100);
  });
  state.activity.unshift({ id: randomUUID(), date, text: 'Para piyasası getirisi ayırmalara dağıtıldı', amount });
}

/**
 * Bir listeyi kullanıcının sürüklediği sıraya koyar. Hisselerde iki piyasa aynı dizide durur,
 * yalnızca sürüklenen piyasa yer değiştirir. Eksik ya da fazla kayıt gelirse hiçbir şey değişmez.
 */
function reorderList(state, list, keys) {
  const sortable = {
    'holdings:BIST': [state.holdings.filter((h) => h.market === 'BIST'), (h) => h.symbol],
    'holdings:US': [state.holdings.filter((h) => h.market === 'US'), (h) => h.symbol],
    funds: [state.funds, (r) => r.id],
    gold: [state.gold, (r) => r.id],
    accounts: [state.accounts, (r) => r.id],
    cards: [state.cards, (r) => r.id],
    incomes: [state.incomes, (r) => r.id],
    expenses: [state.expenses, (r) => r.id],
    buckets: [state.moneyMarket.buckets, (r) => r.id],
  };
  if (!Object.hasOwn(sortable, list)) throw new Error(`Bilinmeyen liste: ${list}`);
  const [records, keyOf] = sortable[list];
  const byKey = new Map(records.map((r) => [keyOf(r), r]));
  if (!Array.isArray(keys) || keys.length !== records.length || new Set(keys).size !== keys.length || !keys.every((k) => byKey.has(k))) {
    throw new Error('Sıralama listeyle uyuşmuyor, sayfayı yenileyip tekrar dene');
  }
  const ordered = keys.map((k) => byKey.get(k));
  if (list.startsWith('holdings:')) {
    const market = list.split(':')[1];
    state.holdings = [...state.holdings.filter((h) => h.market !== market), ...ordered];
  } else if (list === 'buckets') {
    state.moneyMarket.buckets = ordered;
  } else {
    state[list] = ordered;
  }
}

function requireDate(value, today) {
  const date = value ?? today;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Tarih geçersiz');
  return date;
}

/** Düzenli gelir ve giderlerin ortak ekleme/güncelleme mantığı. */
function setRecurring(state, listName, op, today, label, accountHint) {
  const list = state[listName];
  const record = findByName(list, op.name, `${label} adı`);
  const amount = op.amount == null ? record?.amount : requireNumber(op.amount, `${label} tutarı`);
  const day = op.day == null ? record?.day : requireDay(op.day, 'Ayın günü');
  const accountName = op.accountName ?? null;
  const account = accountName
    ? findByName(state.accounts, accountName, 'Hesap adı')
    : state.accounts.find((a) => a.id === record?.accountId);
  if (amount === undefined || day === undefined) throw new Error(`Yeni ${label.toLowerCase()} için tutar ve gün gerekli`);
  if (!account) throw new Error(`${accountHint} bulunamadı: ${accountName ?? 'belirtilmedi'}`);
  if (record) {
    const dayChanged = record.day !== day;
    Object.assign(record, { amount, day, accountId: account.id });
    if (dayChanged) record.nextDate = nextOccurrenceAfter(today, day);
  } else {
    // İlk işlem bugünden sonraki ilk tarih: bugünkü bakiye zaten elle girildiği için çift sayılmaz.
    list.push({ id: randomUUID(), name: op.name.trim(), amount, day, accountId: account.id, nextDate: nextOccurrenceAfter(today, day) });
  }
}

function normalizeFundCode(value) {
  const code = requireText(value, 'Fon kodu').toUpperCase().replace(/İ/g, 'I');
  if (!/^[A-Z0-9]{2,6}$/.test(code)) throw new Error(`Geçersiz fon kodu: ${code}`);
  return code;
}

function requirePositive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${label} sıfırdan büyük olmalı`);
  return value;
}

/** Hisse alım/satımını uygular; işlemin geri alınabilmesi için önceki kaydı ve gerçekleşen kârı döner. */
function tradeHolding(state, kind, symbol, side, quantity, price) {
  const existing = state.holdings.find((h) => h.symbol === symbol && h.market === kind);
  const before = existing ? { ...existing } : null;
  if (side === 'buy') {
    if (existing) {
      const total = existing.quantity + quantity;
      if (existing.avgCost != null) existing.avgCost = Math.round(((existing.avgCost * existing.quantity + price * quantity) / total) * 1e4) / 1e4;
      existing.quantity = Math.round(total * 1e9) / 1e9;
      return { before, realized: null, after: existing.quantity };
    }
    state.holdings.push({ symbol, market: kind, quantity, avgCost: price });
    return { before, realized: null, after: quantity };
  }
  if (!existing || quantity > existing.quantity) {
    throw new Error(`${symbol} için elinde ${existing?.quantity ?? 0} adet var, ${quantity} adet satılamaz`);
  }
  const realized = existing.avgCost == null ? null : round2((price - existing.avgCost) * quantity);
  const left = Math.round((existing.quantity - quantity) * 1e9) / 1e9;
  if (left === 0) state.holdings = state.holdings.filter((h) => h !== existing);
  else existing.quantity = left;
  return { before, realized, after: left };
}

/** Fon alım/satımını pay adedi üzerinden uygular. */
function tradeFund(state, code, side, quantity, price, date) {
  const existing = findByName(state.funds, code, 'Fon kodu');
  const before = existing ? { ...existing } : null;
  if (existing && existing.units == null) {
    throw new Error(`${existing.name} fonunun pay adedi henüz bilinmiyor, biraz sonra tekrar dene`);
  }
  if (side === 'buy') {
    if (existing) {
      existing.units = Math.round((existing.units + quantity) * 1e6) / 1e6;
      if (existing.cost != null) existing.cost = round2(existing.cost + quantity * price);
      existing.value = round2(existing.units * (existing.price ?? price));
      return { before, realized: null, after: existing.units };
    }
    const value = round2(quantity * price);
    state.funds.push({ id: randomUUID(), name: code, value, cost: value, moneyMarket: false, units: quantity, price, updatedAt: date });
    return { before, realized: null, after: quantity };
  }
  if (!existing || quantity > existing.units) {
    throw new Error(`${code} için elinde ${existing?.units ?? 0} pay var, ${quantity} pay satılamaz`);
  }
  const unitCost = existing.cost == null ? null : existing.cost / existing.units;
  const realized = unitCost === null ? null : round2((price - unitCost) * quantity);
  const left = Math.round((existing.units - quantity) * 1e6) / 1e6;
  if (left === 0) {
    state.funds = state.funds.filter((f) => f !== existing);
  } else {
    existing.units = left;
    if (unitCost !== null) existing.cost = round2(unitCost * left);
    existing.value = round2(left * (existing.price ?? price));
  }
  return { before, realized, after: left };
}

function currentTradeQuantity(state, trade) {
  if (trade.kind === 'FUND') return findByName(state.funds, trade.symbol, 'Fon kodu')?.units ?? 0;
  return state.holdings.find((h) => h.symbol === trade.symbol && h.market === trade.kind)?.quantity ?? 0;
}

/**
 * Tek bir değişikliği uygular. Hem elle yapılan düzenlemeler hem de asistan önerileri
 * buradan geçer. Hisse dışındaki kayıtlar isimle eşleşir; yoksa oluşturulur.
 */
export function applyOperation(state, op, today) {
  switch (op.type) {
    case 'set_holding': {
      const market = normalizeMarket(op.market);
      const symbol = normalizeSymbol(op.symbol, market);
      const quantity = requireQuantity(op.quantity, `${symbol} adedi`);
      const existing = state.holdings.find((h) => h.symbol === symbol && h.market === market);
      const avgCost = op.avgCost == null ? existing?.avgCost ?? null : requireNumber(op.avgCost, `${symbol} maliyeti`);
      if (quantity === 0) {
        state.holdings = state.holdings.filter((h) => h !== existing);
      } else if (existing) {
        Object.assign(existing, { quantity, avgCost });
      } else {
        state.holdings.push({ symbol, market, quantity, avgCost });
      }
      break;
    }
    case 'remove_holding': {
      const market = normalizeMarket(op.market);
      const symbol = normalizeSymbol(op.symbol, market);
      state.holdings = state.holdings.filter((h) => !(h.symbol === symbol && h.market === market));
      break;
    }
    case 'set_fund': {
      const fund = findByName(state.funds, op.name, 'Fon adı');
      const value = op.amount == null ? fund?.value : requireNumber(op.amount, 'Fon değeri');
      if (value === undefined) throw new Error('Yeni fon için değer gerekli');
      // Gönderilmeyen maliyet korunur; boş gönderilen maliyet silinir (düzenleme penceresinde alanı boşaltmak).
      let cost = fund?.cost ?? null;
      if (op.cost === null) cost = null;
      else if (op.cost !== undefined) cost = requireNumber(op.cost, 'Fon maliyeti');
      const moneyMarket = op.moneyMarket ?? fund?.moneyMarket ?? false;
      if (fund) {
        // Değer değiştiyse pay adedi de değişmiş olabilir; sonraki fiyat güncellemesinde yeniden çıkarılır.
        if (value !== fund.value) Object.assign(fund, { value, updatedAt: today, units: null });
        Object.assign(fund, { cost, moneyMarket });
      } else {
        state.funds.push({ id: randomUUID(), name: op.name.trim(), value, cost, moneyMarket, units: null, updatedAt: today });
      }
      break;
    }
    case 'remove_fund': {
      const fund = findByName(state.funds, op.name, 'Fon adı');
      if (!fund) throw new Error(`Fon bulunamadı: ${op.name}`);
      state.funds = state.funds.filter((f) => f !== fund);
      break;
    }
    case 'dismiss_sample': {
      state.isSample = false;
      break;
    }
    case 'reorder': {
      reorderList(state, op.list, op.keys);
      break;
    }
    case 'set_account': {
      const balance = requireNumber(op.amount, 'Bakiye', { min: -Infinity });
      const account = findByName(state.accounts, op.name, 'Hesap adı');
      if (account) account.balance = balance;
      else state.accounts.push({ id: randomUUID(), name: op.name.trim(), balance });
      break;
    }
    case 'remove_account': {
      const account = findByName(state.accounts, op.name, 'Hesap adı');
      if (!account) throw new Error(`Hesap bulunamadı: ${op.name}`);
      if (state.incomes.some((s) => s.accountId === account.id)) {
        throw new Error(`${account.name} hesabına bağlı gelir var, önce geliri silin`);
      }
      if (state.expenses.some((e) => e.accountId === account.id)) {
        throw new Error(`${account.name} hesabına bağlı gider var, önce gideri silin`);
      }
      state.accounts = state.accounts.filter((a) => a !== account);
      break;
    }
    case 'set_card': {
      const card = findByName(state.cards, op.name, 'Kart adı');
      const debt = op.amount == null ? card?.debt : requireNumber(op.amount, 'Kart borcu');
      const statementDay = op.statementDay == null ? card?.statementDay : requireDay(op.statementDay, 'Kesim günü');
      const dueDay = op.dueDay == null ? card?.dueDay : requireDay(op.dueDay, 'Son ödeme günü');
      if (debt === undefined || statementDay === undefined || dueDay === undefined) {
        throw new Error('Yeni kart için borç, kesim günü ve son ödeme günü gerekli');
      }
      if (card) Object.assign(card, { debt, statementDay, dueDay });
      else state.cards.push({ id: randomUUID(), name: op.name.trim(), debt, statementDay, dueDay });
      break;
    }
    case 'remove_card': {
      const card = findByName(state.cards, op.name, 'Kart adı');
      if (!card) throw new Error(`Kart bulunamadı: ${op.name}`);
      state.cards = state.cards.filter((c) => c !== card);
      for (const bucket of state.moneyMarket.buckets) {
        if (bucket.cardId === card.id) bucket.cardId = null;
      }
      break;
    }
    case 'set_income': {
      setRecurring(state, 'incomes', op, today, 'Gelir', 'Gelirin yatacağı hesap');
      break;
    }
    case 'remove_income': {
      const income = findByName(state.incomes, op.name, 'Gelir adı');
      if (!income) throw new Error(`Gelir bulunamadı: ${op.name}`);
      state.incomes = state.incomes.filter((s) => s !== income);
      break;
    }
    case 'set_expense': {
      setRecurring(state, 'expenses', op, today, 'Gider', 'Giderin çekileceği hesap');
      break;
    }
    case 'remove_expense': {
      const expense = findByName(state.expenses, op.name, 'Gider adı');
      if (!expense) throw new Error(`Gider bulunamadı: ${op.name}`);
      state.expenses = state.expenses.filter((e) => e !== expense);
      break;
    }
    case 'pay_card': {
      const card = findByName(state.cards, op.name, 'Kart adı');
      if (!card) throw new Error(`Kart bulunamadı: ${op.name}`);
      const amount = round2(requirePositive(op.amount, 'Ödeme tutarı'));
      if (amount > card.debt) throw new Error(`Ödeme (${amount} TL), kart borcundan (${card.debt} TL) fazla olamaz`);
      let from;
      if (op.source === 'account') {
        const account = findByName(state.accounts, op.sourceName, 'Hesap adı');
        if (!account) throw new Error(`Hesap bulunamadı: ${op.sourceName}`);
        account.balance = round2(account.balance - amount);
        from = account.name;
      } else if (op.source === 'bucket') {
        const bucket = findByName(state.moneyMarket.buckets, op.sourceName, 'Ayırma adı');
        if (!bucket) throw new Error(`Ayırma bulunamadı: ${op.sourceName}`);
        if (amount > bucket.amount) throw new Error(`${bucket.name} ayırmasında ${bucket.amount} TL var, ${amount} TL ödenemez`);
        if (!op.fundName) throw new Error('Paranın çıkacağı para piyasası fonunu seç');
        const fund = findByName(state.funds, op.fundName, 'Fon kodu');
        if (!fund?.moneyMarket) throw new Error(`Para piyasası fonu bulunamadı: ${op.fundName}`);
        if (amount > fund.value) throw new Error(`${fund.name} fonunda ${fund.value} TL var, ${amount} TL çıkarılamaz`);
        bucket.amount = round2(bucket.amount - amount);
        if (fund.cost != null) fund.cost = round2(fund.cost * (1 - amount / fund.value));
        // Pay adedi kalan değerden bir sonraki fiyat güncellemesinde yeniden çıkarılır.
        Object.assign(fund, { value: round2(fund.value - amount), units: null, updatedAt: today });
        from = `${fund.name} fonu, ${bucket.name} ayırması`;
      } else {
        throw new Error('Ödeme kaynağını seç');
      }
      card.debt = round2(card.debt - amount);
      state.activity.unshift({ id: randomUUID(), date: today, text: `${card.name} ödendi (${from})`, amount: -amount });
      break;
    }
    case 'add_trade': {
      const kind = op.kind ?? 'BIST';
      if (!['BIST', 'US', 'FUND'].includes(kind)) throw new Error(`Bilinmeyen işlem türü: ${kind}`);
      if (op.side !== 'buy' && op.side !== 'sell') throw new Error('Alış mı satış mı olduğunu seç');
      const symbol = kind === 'FUND' ? normalizeFundCode(op.symbol) : normalizeSymbol(op.symbol, kind);
      const quantity = requirePositive(op.quantity, 'Adet');
      const price = requirePositive(op.price, 'Fiyat');
      const date = requireDate(op.date, today);
      let account = null;
      if (op.accountName) {
        if (kind === 'US') throw new Error('ABD işlemleri dolar olduğu için TL hesabına bağlanamaz');
        account = findByName(state.accounts, op.accountName, 'Hesap adı');
        if (!account) throw new Error(`Hesap bulunamadı: ${op.accountName}`);
      }
      const result = kind === 'FUND'
        ? tradeFund(state, symbol, op.side, quantity, price, date)
        : tradeHolding(state, kind, symbol, op.side, quantity, price);
      const total = round2(quantity * price);
      if (account) account.balance = round2(account.balance + (op.side === 'buy' ? -total : total));
      state.trades.unshift({
        id: randomUUID(), date, kind, symbol, side: op.side, quantity, price, total,
        realized: result.realized, accountId: account?.id ?? null, before: result.before, after: result.after,
      });
      break;
    }
    case 'remove_trade': {
      const trade = state.trades.find((t) => t.id === op.id);
      if (!trade) throw new Error('İşlem bulunamadı');
      // Ortalama maliyet sıraya bağlı olduğu için yalnızca en son işlem güvenle geri alınabilir.
      const newest = state.trades.find((t) => t.kind === trade.kind && t.symbol === trade.symbol);
      if (newest !== trade) throw new Error(`Önce ${trade.symbol} için daha yeni işlemleri sil`);
      if (currentTradeQuantity(state, trade) !== trade.after) {
        throw new Error(`${trade.symbol} bu işlemden sonra elle değişmiş, işlem geri alınamaz`);
      }
      if (trade.kind === 'FUND') {
        state.funds = state.funds.filter((f) => nameKey(f.name) !== nameKey(trade.symbol));
        if (trade.before) state.funds.push(trade.before);
      } else {
        state.holdings = state.holdings.filter((h) => !(h.symbol === trade.symbol && h.market === trade.kind));
        if (trade.before) state.holdings.push(trade.before);
      }
      const account = state.accounts.find((a) => a.id === trade.accountId);
      if (account) account.balance = round2(account.balance + (trade.side === 'buy' ? trade.total : -trade.total));
      state.trades = state.trades.filter((t) => t !== trade);
      break;
    }
    case 'set_gold': {
      if (op.kind !== 'gram' && op.kind !== 'ons') throw new Error('Altın türü gram ya da ons olmalı');
      const quantity = requirePositive(op.quantity, 'Altın miktarı');
      const buyPrice = requirePositive(op.price, 'Alım fiyatı');
      const date = requireDate(op.date, today);
      const lot = state.gold.find((g) => g.id === op.id);
      if (op.id && !lot) throw new Error('Altın kaydı bulunamadı');
      if (lot) Object.assign(lot, { kind: op.kind, quantity, buyPrice, date });
      else state.gold.push({ id: randomUUID(), kind: op.kind, quantity, buyPrice, date });
      break;
    }
    case 'remove_gold': {
      if (!state.gold.some((g) => g.id === op.id)) throw new Error('Altın kaydı bulunamadı');
      state.gold = state.gold.filter((g) => g.id !== op.id);
      break;
    }
    case 'set_bucket': {
      const amount = requireNumber(op.amount, 'Ayrılan tutar');
      const bucket = findByName(state.moneyMarket.buckets, op.name, 'Ayırma adı');
      let cardId = bucket?.cardId ?? null;
      if (op.cardName !== undefined) {
        if (op.cardName === null || op.cardName === '') {
          cardId = null;
        } else {
          const card = findByName(state.cards, op.cardName, 'Kart adı');
          if (!card) throw new Error(`Kart bulunamadı: ${op.cardName}`);
          cardId = card.id;
        }
      }
      if (bucket) Object.assign(bucket, { amount, cardId });
      else state.moneyMarket.buckets.push({ id: randomUUID(), name: op.name.trim(), amount, cardId });
      checkMoneyMarket(state);
      break;
    }
    case 'remove_bucket': {
      const bucket = findByName(state.moneyMarket.buckets, op.name, 'Ayırma adı');
      if (!bucket) throw new Error(`Ayırma bulunamadı: ${op.name}`);
      state.moneyMarket.buckets = state.moneyMarket.buckets.filter((b) => b !== bucket);
      break;
    }
    case 'add_note': {
      state.notes.unshift({
        id: randomUUID(),
        text: requireText(op.text, 'Not'),
        date: op.date ?? null,
        createdAt: today,
      });
      break;
    }
    case 'remove_note': {
      state.notes = state.notes.filter((n) => n.id !== op.id);
      break;
    }
    default:
      throw new Error(`Bilinmeyen işlem: ${op.type}`);
  }
}

/** Hepsi ya da hiçbiri: bir işlem hata verirse durum değişmeden kalır. */
export function applyOperations(state, operations, today) {
  const draft = structuredClone(state);
  for (const op of operations) applyOperation(draft, op, today);
  return draft;
}

/** Arayüzün gösterdiği kart ve para piyasası hesapları. */
export function deriveView(state, today) {
  const cards = state.cards.map((card) => {
    const nextStatement = nextOccurrenceOnOrAfter(today, card.statementDay);
    const nextDue = nextOccurrenceOnOrAfter(today, card.dueDay);
    const reserved = round2(
      state.moneyMarket.buckets.filter((b) => b.cardId === card.id).reduce((sum, b) => sum + b.amount, 0),
    );
    return {
      ...card,
      nextStatement,
      nextDue,
      daysToDue: daysBetween(today, nextDue),
      reserved,
      shortfall: round2(Math.max(0, card.debt - reserved)),
    };
  });
  const incomes = state.incomes.map((s) => ({
    ...s,
    accountName: state.accounts.find((a) => a.id === s.accountId)?.name ?? '—',
    daysToNext: daysBetween(today, s.nextDate),
  }));
  const expenses = state.expenses.map((e) => ({
    ...e,
    accountName: state.accounts.find((a) => a.id === e.accountId)?.name ?? '—',
    daysToNext: daysBetween(today, e.nextDate),
  }));
  const allocated = allocatedTotal(state);
  const total = moneyMarketTotal(state);
  const cashTotal = round2(state.accounts.reduce((sum, a) => sum + a.balance, 0));

  // Ay sonu tahmini: bu ay daha yatacak gelirler ve çıkacak giderler. Kart borcunun para piyasasında
  // ayrılan kısmı bankadan çıkmayacağı için yalnızca karşılanmayan kısım düşülür.
  const [year, month] = today.split('-').map(Number);
  const monthEndDate = dateInMonth(year, month, 31);
  const pendingIncomes = incomes.filter((i) => i.nextDate <= monthEndDate);
  const pendingExpenses = expenses.filter((e) => e.nextDate <= monthEndDate);
  const dueCards = cards.filter((c) => c.debt > 0 && c.nextDue <= monthEndDate);
  const sum = (list, pick) => round2(list.reduce((acc, item) => acc + pick(item), 0));
  const incomeTotal = sum(pendingIncomes, (i) => i.amount);
  const expenseTotal = sum(pendingExpenses, (e) => e.amount);
  const cardFromBank = sum(dueCards, (c) => c.shortfall);

  return {
    today,
    cards,
    incomes,
    expenses,
    monthEnd: {
      date: monthEndDate,
      cash: cashTotal,
      pendingIncomes,
      pendingExpenses,
      dueCards,
      incomeTotal,
      expenseTotal,
      cardFromBank,
      estimate: round2(cashTotal + incomeTotal - expenseTotal - cardFromBank),
    },
    realizedTotal: sum(state.trades.filter((t) => t.kind !== 'US' && t.realized != null), (t) => t.realized),
    realizedUsd: sum(state.trades.filter((t) => t.kind === 'US' && t.realized != null), (t) => t.realized),
    moneyMarket: { ...state.moneyMarket, total, allocated, unallocated: round2(total - allocated) },
    fundsTotal: round2(state.funds.reduce((sum, f) => sum + f.value, 0)),
    cashTotal,
    debtTotal: round2(state.cards.reduce((sum, c) => sum + c.debt, 0)),
  };
}

export function emptyState() {
  return {
    isSample: false,
    accounts: [],
    cards: [],
    incomes: [],
    expenses: [],
    holdings: [],
    funds: [],
    gold: [],
    trades: [],
    history: [],
    moneyMarket: { buckets: [] },
    notes: [],
    activity: [],
  };
}

/** İlk açılışta gösterilen örnek veri; tutarlar temsilîdir. */
export function sampleState(today) {
  const state = emptyState();
  state.isSample = true;
  const ops = [
    { type: 'set_account', name: 'Örnek Banka', amount: 18450 },
    { type: 'set_card', name: 'Örnek Kredi Kartı', amount: 12300, statementDay: 18, dueDay: 28 },
    { type: 'set_income', name: 'Örnek Maaş', amount: 7500, day: 1, accountName: 'Örnek Banka' },
    { type: 'set_holding', symbol: 'THYAO', quantity: 40, avgCost: 265 },
    { type: 'set_holding', symbol: 'ASELS', quantity: 25, avgCost: 150 },
    { type: 'set_holding', symbol: 'BIMAS', quantity: 12, avgCost: 480 },
    { type: 'set_fund', name: 'Örnek para piyasası fonu', amount: 25000, moneyMarket: true },
    { type: 'set_bucket', name: 'Uzun vade', amount: 10000 },
    { type: 'set_bucket', name: 'Kredi kartı ödemesi', amount: 15000, cardName: 'Örnek Kredi Kartı' },
  ];
  for (const op of ops) applyOperation(state, op, today);
  return state;
}
