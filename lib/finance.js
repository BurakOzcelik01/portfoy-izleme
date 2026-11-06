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
    const [latest] = list;
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
      const cost = op.cost == null ? fund?.cost ?? null : requireNumber(op.cost, 'Fon maliyeti');
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
      const income = findByName(state.incomes, op.name, 'Gelir adı');
      const amount = op.amount == null ? income?.amount : requireNumber(op.amount, 'Gelir tutarı');
      const day = op.day == null ? income?.day : requireDay(op.day, 'Yatış günü');
      const accountName = op.accountName ?? null;
      const account = accountName
        ? findByName(state.accounts, accountName, 'Hesap adı')
        : state.accounts.find((a) => a.id === income?.accountId);
      if (amount === undefined || day === undefined) {
        throw new Error('Yeni gelir için tutar ve yatış günü gerekli');
      }
      if (!account) throw new Error(`Gelirin yatacağı hesap bulunamadı: ${accountName ?? 'belirtilmedi'}`);
      if (income) {
        const dayChanged = income.day !== day;
        Object.assign(income, { amount, day, accountId: account.id });
        if (dayChanged) income.nextDate = nextOccurrenceAfter(today, day);
      } else {
        // İlk yatış bugünden sonraki ilk tarih: bugünkü bakiye zaten elle girildiği için çift sayılmaz.
        state.incomes.push({
          id: randomUUID(),
          name: op.name.trim(),
          amount,
          day,
          accountId: account.id,
          nextDate: nextOccurrenceAfter(today, day),
        });
      }
      break;
    }
    case 'remove_income': {
      const income = findByName(state.incomes, op.name, 'Gelir adı');
      if (!income) throw new Error(`Gelir bulunamadı: ${op.name}`);
      state.incomes = state.incomes.filter((s) => s !== income);
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
  const allocated = allocatedTotal(state);
  const total = moneyMarketTotal(state);
  return {
    today,
    cards,
    incomes,
    moneyMarket: { ...state.moneyMarket, total, allocated, unallocated: round2(total - allocated) },
    fundsTotal: round2(state.funds.reduce((sum, f) => sum + f.value, 0)),
    cashTotal: round2(state.accounts.reduce((sum, a) => sum + a.balance, 0)),
    debtTotal: round2(state.cards.reduce((sum, c) => sum + c.debt, 0)),
  };
}

export function emptyState() {
  return {
    isSample: false,
    accounts: [],
    cards: [],
    incomes: [],
    holdings: [],
    funds: [],
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
