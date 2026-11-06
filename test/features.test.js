import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDueExpenses,
  applyFundPrices,
  applyOperations,
  computeTotals,
  deriveView,
  emptyState,
  GRAMS_PER_OUNCE,
  goldValueTry,
  normalizeState,
  recordSnapshot,
} from '../lib/finance.js';

const D = '2026-11-06';
const portfolio = (...ops) => applyOperations(emptyState(), ops, D);
const noPrices = { quotes: [], usdTry: null, goldOunceUsd: null };
const at = (iso) => Date.parse(iso);

test('gider vadesi gelince hesaptan düşer ve tekrar düşmez', () => {
  const state = portfolio(
    { type: 'set_account', name: 'Banka A', amount: 1000 },
    { type: 'set_expense', name: 'Kira', amount: 300, day: 15, accountName: 'Banka A' },
  );
  assert.equal(state.expenses[0].nextDate, '2026-11-15');
  applyDueExpenses(state, '2026-11-14');
  assert.equal(state.accounts[0].balance, 1000);
  applyDueExpenses(state, '2026-11-15');
  applyDueExpenses(state, '2026-11-15');
  assert.equal(state.accounts[0].balance, 700);
  assert.equal(state.activity[0].amount, -300);
  assert.throws(() => applyOperations(state, [{ type: 'remove_account', name: 'Banka A' }], D), /bağlı gider/);
});

test('ay sonu tahmini gelir, gider ve kartın karşılanmayan kısmını hesaba katar', () => {
  const state = portfolio(
    { type: 'set_account', name: 'Banka A', amount: 1000 },
    { type: 'set_income', name: 'Maaş', amount: 500, day: 20, accountName: 'Banka A' },
    { type: 'set_income', name: 'Sonraki ay', amount: 999, day: 1, accountName: 'Banka A' },
    { type: 'set_expense', name: 'Kira', amount: 300, day: 25, accountName: 'Banka A' },
    { type: 'set_card', name: 'Kart A', amount: 400, statementDay: 10, dueDay: 28 },
    { type: 'set_fund', name: 'IOO', amount: 1000, moneyMarket: true },
    { type: 'set_bucket', name: 'Kart', amount: 150, cardName: 'Kart A' },
  );
  const { monthEnd } = deriveView(state, D);
  assert.equal(monthEnd.date, '2026-11-30');
  assert.equal(monthEnd.incomeTotal, 500);
  assert.equal(monthEnd.expenseTotal, 300);
  assert.equal(monthEnd.cardFromBank, 250);
  assert.equal(monthEnd.estimate, 950);
});

test('kart hesaptan ödenince borç ve bakiye düşer', () => {
  let state = portfolio(
    { type: 'set_account', name: 'Banka A', amount: 1000 },
    { type: 'set_card', name: 'Kart A', amount: 400, statementDay: 10, dueDay: 28 },
  );
  state = applyOperations(state, [{ type: 'pay_card', name: 'Kart A', amount: 400, source: 'account', sourceName: 'Banka A' }], D);
  assert.equal(state.cards[0].debt, 0);
  assert.equal(state.accounts[0].balance, 600);
  assert.equal(state.activity[0].amount, -400);
  assert.throws(
    () => applyOperations(state, [{ type: 'pay_card', name: 'Kart A', amount: 1, source: 'account', sourceName: 'Banka A' }], D),
    /fazla olamaz/,
  );
});

test('kart para piyasasından ödenince ayırma, fon ve maliyet düşer, ayrılmamış kısım değişmez', () => {
  let state = portfolio(
    { type: 'set_card', name: 'Kart A', amount: 400, statementDay: 10, dueDay: 28 },
    { type: 'set_fund', name: 'IOO', amount: 1000, cost: 800, moneyMarket: true },
    { type: 'set_bucket', name: 'Kart', amount: 400, cardName: 'Kart A' },
  );
  const before = deriveView(state, D).moneyMarket.unallocated;
  state = applyOperations(state, [{ type: 'pay_card', name: 'Kart A', amount: 400, source: 'bucket', sourceName: 'Kart', fundName: 'IOO' }], D);
  assert.equal(state.cards[0].debt, 0);
  assert.equal(state.moneyMarket.buckets[0].amount, 0);
  assert.equal(state.funds[0].value, 600);
  assert.equal(state.funds[0].cost, 480);
  assert.equal(state.funds[0].units, null);
  assert.equal(deriveView(state, D).moneyMarket.unallocated, before);
});

test('kart ödemesinde fon seçilmezse veya ayırma yetmezse hiçbir şey değişmez', () => {
  const state = portfolio(
    { type: 'set_card', name: 'Kart A', amount: 400, statementDay: 10, dueDay: 28 },
    { type: 'set_fund', name: 'IOO', amount: 1000, moneyMarket: true },
    { type: 'set_bucket', name: 'Kart', amount: 100 },
  );
  assert.throws(() => applyOperations(state, [{ type: 'pay_card', name: 'Kart A', amount: 50, source: 'bucket', sourceName: 'Kart' }], D), /fonunu seç/);
  assert.throws(() => applyOperations(state, [{ type: 'pay_card', name: 'Kart A', amount: 200, source: 'bucket', sourceName: 'Kart', fundName: 'IOO' }], D), /ödenemez/);
  assert.equal(state.cards[0].debt, 400);
});

const trade = (over) => ({ type: 'add_trade', kind: 'BIST', symbol: 'THYAO', side: 'buy', quantity: 10, price: 100, date: D, ...over });

test('alış ortalama maliyeti hesaplar, satış gerçekleşen kârı yazar ve maliyeti değiştirmez', () => {
  let state = portfolio(trade(), trade({ quantity: 10, price: 200 }));
  assert.deepEqual(state.holdings[0], { symbol: 'THYAO', market: 'BIST', quantity: 20, avgCost: 150 });
  state = applyOperations(state, [trade({ side: 'sell', quantity: 5, price: 180 })], D);
  assert.equal(state.holdings[0].quantity, 15);
  assert.equal(state.holdings[0].avgCost, 150);
  assert.equal(state.trades[0].realized, 150);
  assert.equal(deriveView(state, D).realizedTotal, 150);
  state = applyOperations(state, [trade({ side: 'sell', quantity: 15, price: 100 })], D);
  assert.equal(state.holdings.length, 0);
  assert.equal(deriveView(state, D).realizedTotal, -600);
});

test('elindekinden fazla satış reddedilir', () => {
  const state = portfolio(trade());
  assert.throws(() => applyOperations(state, [trade({ side: 'sell', quantity: 11 })], D), /satılamaz/);
  assert.throws(() => applyOperations(state, [trade({ symbol: 'ASELS', side: 'sell', quantity: 1 })], D), /satılamaz/);
});

test('işlem seçilen hesabı değiştirir, ABD işlemi TL hesabına bağlanamaz', () => {
  let state = portfolio({ type: 'set_account', name: 'Banka A', amount: 5000 }, trade({ accountName: 'Banka A' }));
  assert.equal(state.accounts[0].balance, 4000);
  state = applyOperations(state, [trade({ side: 'sell', quantity: 5, price: 120, accountName: 'Banka A' })], D);
  assert.equal(state.accounts[0].balance, 4600);
  assert.throws(() => applyOperations(state, [trade({ kind: 'US', symbol: 'VOO', accountName: 'Banka A' })], D), /dolar/);
});

test('en son işlem silinince önceki hal geri gelir, eski işlem silinemez', () => {
  let state = portfolio(
    { type: 'set_account', name: 'Banka A', amount: 5000 },
    trade(),
    trade({ quantity: 10, price: 200, accountName: 'Banka A' }),
  );
  const [newest, oldest] = state.trades;
  assert.throws(() => applyOperations(state, [{ type: 'remove_trade', id: oldest.id }], D), /daha yeni/);
  state = applyOperations(state, [{ type: 'remove_trade', id: newest.id }], D);
  assert.deepEqual(state.holdings[0], { symbol: 'THYAO', market: 'BIST', quantity: 10, avgCost: 100 });
  assert.equal(state.accounts[0].balance, 5000);
  assert.equal(state.trades.length, 1);
});

test('hisse işlemden sonra elle değiştiyse işlem geri alınamaz', () => {
  let state = portfolio(trade());
  state = applyOperations(state, [{ type: 'set_holding', symbol: 'THYAO', quantity: 99 }], D);
  assert.throws(() => applyOperations(state, [{ type: 'remove_trade', id: state.trades[0].id }], D), /elle değişmiş/);
});

test('fon alım satımı pay, maliyet ve değeri günceller; kısmi satış kârı yazılır', () => {
  let state = portfolio(trade({ kind: 'FUND', symbol: 'ioo', quantity: 100, price: 5 }));
  assert.equal(state.funds[0].name, 'IOO');
  assert.equal(state.funds[0].value, 500);
  assert.equal(state.funds[0].cost, 500);
  state = applyOperations(state, [trade({ kind: 'FUND', symbol: 'IOO', side: 'sell', quantity: 40, price: 6 })], D);
  assert.equal(state.funds[0].units, 60);
  assert.equal(state.funds[0].cost, 300);
  assert.equal(state.trades[0].realized, 40);
  state = applyOperations(state, [{ type: 'remove_trade', id: state.trades[0].id }], D);
  assert.equal(state.funds[0].units, 100);
  assert.equal(state.funds[0].cost, 500);
});

test('pay adedi bilinmeyen fonda işlem yapılmaz', () => {
  const state = portfolio({ type: 'set_fund', name: 'IOO', amount: 100 });
  assert.throws(() => applyOperations(state, [trade({ kind: 'FUND', symbol: 'IOO', quantity: 1 })], D), /pay adedi/);
});

test('altın gram ve ons olarak eklenir, net varlığa TL değeriyle girer', () => {
  const state = portfolio(
    { type: 'set_gold', kind: 'gram', quantity: 10, price: 5000 },
    { type: 'set_gold', kind: 'ons', quantity: 1, price: 3500 },
  );
  assert.equal(state.gold.length, 2);
  assert.equal(Math.round(goldValueTry(state.gold[1], 4000, 50)), 200000);
  const gramValue = (10 * 4000 * 50) / GRAMS_PER_OUNCE;
  assert.equal(Math.round(goldValueTry(state.gold[0], 4000, 50)), Math.round(gramValue));
  const totals = computeTotals(state, { quotes: [], usdTry: 50, goldOunceUsd: 4000 });
  assert.equal(totals.missing, 0);
  assert.equal(Math.round(totals.net), Math.round(200000 + gramValue));
  assert.equal(computeTotals(state, noPrices).missing, 2);
  assert.throws(() => applyOperations(state, [{ type: 'set_gold', kind: 'çeyrek', quantity: 1, price: 1 }], D), /gram ya da ons/);
  const removed = applyOperations(state, [{ type: 'remove_gold', id: state.gold[0].id }], D);
  assert.equal(removed.gold.length, 1);
});

test('net varlık hisse, fon, nakit ve borcu toplar; para piyasasını iki kez saymaz', () => {
  const state = portfolio(
    { type: 'set_account', name: 'Banka A', amount: 1000 },
    { type: 'set_card', name: 'Kart A', amount: 200, statementDay: 1, dueDay: 2 },
    { type: 'set_holding', symbol: 'THYAO', quantity: 2 },
    { type: 'set_holding', symbol: 'VOO', market: 'US', quantity: 1 },
    { type: 'set_fund', name: 'IOO', amount: 300, moneyMarket: true },
    { type: 'set_fund', name: 'IJC', amount: 100 },
  );
  const totals = computeTotals(state, {
    quotes: [{ symbol: 'THYAO', market: 'BIST', price: 10 }, { symbol: 'VOO', market: 'US', price: 2 }],
    usdTry: 50,
    goldOunceUsd: null,
  });
  assert.equal(totals.stocks, 120);
  assert.equal(totals.funds, 400);
  assert.equal(totals.moneyMarket, 300);
  assert.equal(totals.net, 1320);
  assert.equal(totals.missing, 0);
});

test('geçmiş günde tek kayıt tutar, eksik fiyatlı toplamı yazmaz', () => {
  const state = portfolio({ type: 'set_holding', symbol: 'THYAO', quantity: 1 });
  assert.equal(recordSnapshot(state, D, computeTotals(state, noPrices)), false);
  assert.equal(state.history.length, 0);
  const priced = (price) => computeTotals(state, { quotes: [{ symbol: 'THYAO', market: 'BIST', price }], usdTry: null, goldOunceUsd: null });
  assert.equal(recordSnapshot(state, D, priced(10)), true);
  assert.equal(recordSnapshot(state, D, priced(10)), false);
  assert.equal(recordSnapshot(state, D, priced(20)), true);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].net, 20);
  recordSnapshot(state, '2026-11-07', priced(30));
  assert.deepEqual(state.history.map((h) => h.net), [20, 30]);
});

test('günlük kâr/zarar hisse, ABD hissesi, fon ve altını kapsar; yüzde yatırımlara göredir', () => {
  const state = portfolio(
    { type: 'set_account', name: 'Banka A', amount: 100000 },
    { type: 'set_holding', symbol: 'THYAO', quantity: 11 },
    { type: 'set_holding', symbol: 'VOO', market: 'US', quantity: 1 },
    { type: 'set_gold', kind: 'ons', quantity: 1, price: 1000 },
    { type: 'set_fund', name: 'IOO', amount: 1000 },
  );
  applyFundPrices(state, new Map([['IOO', [{ date: D, price: 11 }, { date: '2026-11-05', price: 10 }]]]));
  // THYAO 110 TL: dün 100, +10. VOO 21 $ × 10 TL = 210: dün 200, +10. Altın 110 $ × 10 = 1100: dün 1000, +100.
  const totals = computeTotals(state, {
    quotes: [
      { symbol: 'THYAO', market: 'BIST', price: 10, changePercent: 10, marketTime: at('2026-11-06T09:00:00Z') },
      { symbol: 'VOO', market: 'US', price: 21, changePercent: 5, marketTime: at('2026-11-06T15:00:00Z') },
    ],
    usdTry: 10,
    goldOunceUsd: 110,
    goldChangePercent: 10,
    goldMarketTime: at('2026-11-06T09:00:00Z'),
  }, D);
  const fundGain = state.funds[0].units * 1;
  assert.equal(totals.dailyChange, Math.round((10 + 10 + 100 + fundGain) * 100) / 100);
  const previous = 110 + 210 + 1100 + state.funds[0].value - totals.dailyChange;
  // dailyChange kuruşa yuvarlıdır, yüzde yuvarlanmamış tutardan hesaplanır.
  assert.ok(Math.abs(totals.dailyPercent - (totals.dailyChange / previous) * 100) < 1e-3);
});

test('dünkü ABD seansı bugünkü değişime girmez, New York günü bugünse girer', () => {
  const state = portfolio({ type: 'set_holding', symbol: 'VOO', market: 'US', quantity: 1 });
  const market = (time) => ({
    quotes: [{ symbol: 'VOO', market: 'US', price: 110, changePercent: 10, marketTime: at(time) }],
    usdTry: 1,
    goldOunceUsd: null,
  });
  // Perşembe kapanışı İstanbul'da Cuma 00:00'dır ama Perşembe seansıdır.
  assert.equal(computeTotals(state, market('2026-11-05T21:00:00Z'), '2026-11-06').dailyChange, 0);
  assert.equal(computeTotals(state, market('2026-11-06T15:00:00Z'), '2026-11-06').dailyChange, 10);
});

test('hafta sonu önceki günün hisse, fon ve altın değişimi bugün sayılmaz', () => {
  const state = portfolio(
    { type: 'set_holding', symbol: 'THYAO', quantity: 1 },
    { type: 'set_gold', kind: 'gram', quantity: 1, price: 1 },
    { type: 'set_fund', name: 'IOO', amount: 100 },
  );
  applyFundPrices(state, new Map([['IOO', [{ date: D, price: 11 }, { date: '2026-11-05', price: 10 }]]]));
  const friday = at('2026-11-06T12:00:00Z');
  const market = {
    quotes: [{ symbol: 'THYAO', market: 'BIST', price: 10, changePercent: 5, marketTime: friday }],
    usdTry: 1,
    goldOunceUsd: 100,
    goldChangePercent: 5,
    goldMarketTime: friday,
  };
  assert.notEqual(computeTotals(state, market, D).dailyChange, 0);
  assert.equal(computeTotals(state, market, '2026-11-07').dailyChange, 0);
});

test('fon maliyeti boş gönderilirse silinir, hiç gönderilmezse korunur', () => {
  let state = portfolio({ type: 'set_fund', name: 'PPI', amount: 100, cost: 90 });
  state = applyOperations(state, [{ type: 'set_fund', name: 'PPI', moneyMarket: true }], D);
  assert.equal(state.funds[0].cost, 90);
  state = applyOperations(state, [{ type: 'set_fund', name: 'PPI', cost: null }], D);
  assert.equal(state.funds[0].cost, null);
  assert.equal(state.funds[0].moneyMarket, true);
  assert.equal(state.funds[0].value, 100);
});

test('fonun tüm dönem kârı bugünkü değişime girmez', () => {
  const state = portfolio({ type: 'set_fund', name: 'IOO', amount: 1000, cost: 500 });
  applyFundPrices(state, new Map([['IOO', [{ date: D, price: 10 }, { date: '2026-11-05', price: 10 }]]]));
  assert.equal(computeTotals(state, noPrices, D).dailyChange, 0);
});

test('değişim verisi yoksa günlük kâr/zarar sıfırdır, yatırım yoksa yüzde verilmez', () => {
  const state = portfolio({ type: 'set_holding', symbol: 'THYAO', quantity: 1 }, { type: 'set_fund', name: 'IOO', amount: 100 });
  const totals = computeTotals(state, { quotes: [{ symbol: 'THYAO', market: 'BIST', price: 10 }], usdTry: 1, goldOunceUsd: null });
  assert.equal(totals.dailyChange, 0);
  assert.equal(totals.dailyPercent, 0);
  assert.equal(computeTotals(portfolio({ type: 'set_account', name: 'Banka A', amount: 5 }), noPrices).dailyPercent, null);
});

test('fonun bugünkü değeri işlenmiş olsa da önceki fiyat sonradan tamamlanır', () => {
  const state = portfolio({ type: 'set_fund', name: 'IOO', amount: 100 });
  applyFundPrices(state, new Map([['IOO', [{ date: D, price: 10 }]]]));
  assert.equal(state.funds[0].prevPrice, undefined);
  const value = state.funds[0].value;
  assert.equal(applyFundPrices(state, new Map([['IOO', [{ date: D, price: 10 }, { date: '2026-11-05', price: 9 }]]])), true);
  assert.equal(state.funds[0].prevPrice, 9);
  assert.equal(state.funds[0].value, value);
});

test('sıralama yalnızca sürüklenen listeyi değiştirir, hisselerde diğer piyasaya dokunmaz', () => {
  let state = portfolio(
    { type: 'set_holding', symbol: 'THYAO', quantity: 1 },
    { type: 'set_holding', symbol: 'VOO', market: 'US', quantity: 1 },
    { type: 'set_holding', symbol: 'ASELS', quantity: 1 },
    { type: 'set_holding', symbol: 'BIMAS', quantity: 1 },
    { type: 'set_holding', symbol: 'AMZN', market: 'US', quantity: 1 },
  );
  state = applyOperations(state, [{ type: 'reorder', list: 'holdings:BIST', keys: ['BIMAS', 'THYAO', 'ASELS'] }], D);
  const symbols = (market) => state.holdings.filter((h) => h.market === market).map((h) => h.symbol);
  assert.deepEqual(symbols('BIST'), ['BIMAS', 'THYAO', 'ASELS']);
  assert.deepEqual(symbols('US'), ['VOO', 'AMZN']);
  state = applyOperations(state, [{ type: 'reorder', list: 'holdings:US', keys: ['AMZN', 'VOO'] }], D);
  assert.deepEqual(symbols('US'), ['AMZN', 'VOO']);
  assert.deepEqual(symbols('BIST'), ['BIMAS', 'THYAO', 'ASELS']);
});

test('fon, hesap, kart, gelir, gider, altın ve ayırma sıralanır', () => {
  let state = portfolio(
    { type: 'set_account', name: 'A', amount: 1 },
    { type: 'set_account', name: 'B', amount: 1 },
    { type: 'set_card', name: 'A', amount: 1, statementDay: 1, dueDay: 2 },
    { type: 'set_card', name: 'B', amount: 1, statementDay: 1, dueDay: 2 },
    { type: 'set_income', name: 'A', amount: 1, day: 1, accountName: 'A' },
    { type: 'set_income', name: 'B', amount: 1, day: 1, accountName: 'A' },
    { type: 'set_expense', name: 'A', amount: 1, day: 1, accountName: 'A' },
    { type: 'set_expense', name: 'B', amount: 1, day: 1, accountName: 'A' },
    { type: 'set_gold', kind: 'gram', quantity: 1, price: 1 },
    { type: 'set_gold', kind: 'ons', quantity: 1, price: 1 },
    { type: 'set_fund', name: 'AA', amount: 100, moneyMarket: true },
    { type: 'set_fund', name: 'BB', amount: 1 },
    { type: 'set_bucket', name: 'A', amount: 1 },
    { type: 'set_bucket', name: 'B', amount: 1 },
  );
  const lists = { accounts: state.accounts, cards: state.cards, incomes: state.incomes, expenses: state.expenses, gold: state.gold, funds: state.funds, buckets: state.moneyMarket.buckets };
  for (const [list, records] of Object.entries(lists)) {
    const reversed = [...records].reverse().map((r) => r.id);
    state = applyOperations(state, [{ type: 'reorder', list, keys: reversed }], D);
    const after = list === 'buckets' ? state.moneyMarket.buckets : state[list];
    assert.deepEqual(after.map((r) => r.id), reversed, list);
  }
});

test('uyuşmayan sıralama reddedilir ve liste değişmez', () => {
  const state = portfolio({ type: 'set_account', name: 'A', amount: 1 }, { type: 'set_account', name: 'B', amount: 1 });
  const [a, b] = state.accounts.map((r) => r.id);
  for (const keys of [[a], [a, a], [a, 'yok'], [a, b, 'fazla'], 'x']) {
    assert.throws(() => applyOperations(state, [{ type: 'reorder', list: 'accounts', keys }], D), /uyuşmuyor/);
  }
  assert.throws(() => applyOperations(state, [{ type: 'reorder', list: 'activity', keys: [] }], D), /Bilinmeyen liste/);
  assert.throws(() => applyOperations(state, [{ type: 'reorder', list: '__proto__', keys: [] }], D), /Bilinmeyen liste/);
  assert.deepEqual(state.accounts.map((r) => r.id), [a, b]);
});

test('eski veri dosyası yeni biçime taşınır, bozuk dosya reddedilir', () => {
  const state = normalizeState({
    accounts: [],
    scholarships: [{ name: 'Burs' }],
    holdings: [{ symbol: 'THYAO', quantity: 1 }],
    moneyMarket: { total: 5, buckets: [{ name: 'A' }] },
  });
  assert.equal(state.incomes[0].name, 'Burs');
  assert.equal('scholarships' in state, false);
  assert.equal(state.holdings[0].market, 'BIST');
  assert.deepEqual(state.moneyMarket, { buckets: [{ name: 'A' }] });
  assert.deepEqual(state.trades, []);
  for (const bad of [null, 'x', {}, { accounts: 'x' }, { accounts: [], funds: 3 }]) {
    assert.throws(() => normalizeState(bad), /geçersiz/);
  }
});
