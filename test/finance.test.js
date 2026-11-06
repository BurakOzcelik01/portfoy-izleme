import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDueScholarships,
  applyFundPrices,
  applyOperations,
  deriveView,
  emptyState,
  nextOccurrenceAfter,
  nextOccurrenceOnOrAfter,
  todayInIstanbul,
} from '../lib/finance.js';

function withScholarship(today) {
  return applyOperations(
    emptyState(),
    [
      { type: 'set_account', name: 'Banka A', amount: 1000 },
      { type: 'set_scholarship', name: 'Burs A', amount: 7500, day: 1, accountName: 'Banka A' },
    ],
    today,
  );
}

test('burs ilk yatış tarihi bugünden sonraki ilk gün olur', () => {
  assert.equal(withScholarship('2026-11-06').scholarships[0].nextDate, '2026-12-01');
  assert.equal(withScholarship('2026-11-01').scholarships[0].nextDate, '2026-12-01');
  assert.equal(withScholarship('2026-10-31').scholarships[0].nextDate, '2026-11-01');
});

test('burs tarihinden önce bakiye değişmez', () => {
  const state = withScholarship('2026-11-06');
  assert.deepEqual(applyDueScholarships(state, '2026-11-30'), []);
  assert.equal(state.accounts[0].balance, 1000);
});

test('burs ayın 1inde hesaba eklenir ve aynı gün tekrar eklenmez', () => {
  const state = withScholarship('2026-11-06');
  assert.equal(applyDueScholarships(state, '2026-12-01').length, 1);
  assert.equal(state.accounts[0].balance, 8500);
  assert.equal(state.scholarships[0].nextDate, '2027-01-01');
  assert.equal(applyDueScholarships(state, '2026-12-01').length, 0);
  assert.equal(state.accounts[0].balance, 8500);
  assert.equal(state.activity.length, 1);
});

test('uygulama aylarca kapalı kalsa da kaçan bursların hepsi eklenir', () => {
  const state = withScholarship('2026-11-06');
  assert.equal(applyDueScholarships(state, '2027-02-15').length, 3);
  assert.equal(state.accounts[0].balance, 1000 + 3 * 7500);
  assert.deepEqual(state.activity.map((a) => a.date), ['2027-02-01', '2027-01-01', '2026-12-01']);
});

test('ayın 31i kısa aylarda son güne çekilir ve sonraki ayda 31e döner', () => {
  assert.equal(nextOccurrenceAfter('2027-01-31', 31), '2027-02-28');
  assert.equal(nextOccurrenceAfter('2027-02-28', 31), '2027-03-31');
  assert.equal(nextOccurrenceAfter('2028-01-31', 31), '2028-02-29');
  assert.equal(nextOccurrenceAfter('2026-12-15', 1), '2027-01-01');
});

test('kart tarihleri bugünü de kapsar', () => {
  assert.equal(nextOccurrenceOnOrAfter('2026-11-28', 28), '2026-11-28');
  assert.equal(nextOccurrenceOnOrAfter('2026-11-29', 28), '2026-12-28');
});

test('para piyasası 25.000 TL 10.000 ve 15.000 olarak ayrılır', () => {
  const state = applyOperations(
    emptyState(),
    [
      { type: 'set_fund', name: 'IOO', amount: 25000, moneyMarket: true },
      { type: 'set_bucket', name: 'Uzun vade', amount: 10000 },
      { type: 'set_bucket', name: 'Kart', amount: 15000 },
    ],
    '2026-11-06',
  );
  const { moneyMarket } = deriveView(state, '2026-11-06');
  assert.equal(moneyMarket.allocated, 25000);
  assert.equal(moneyMarket.unallocated, 0);
});

test('ayrılan toplam para piyasası tutarını aşamaz ve durum değişmez', () => {
  const state = applyOperations(emptyState(), [{ type: 'set_fund', name: 'IOO', amount: 25000, moneyMarket: true }], '2026-11-06');
  assert.throws(
    () => applyOperations(state, [{ type: 'set_bucket', name: 'Fazla', amount: 25001 }], '2026-11-06'),
    /aşıyor/,
  );
  assert.deepEqual(state.moneyMarket.buckets, []);
});

test('para piyasası toplamı yalnızca işaretli fonlardan gelir ve fon düşerse eksik gösterilir', () => {
  let state = applyOperations(
    emptyState(),
    [
      { type: 'set_fund', name: 'ZBJ', amount: 10000, moneyMarket: true },
      { type: 'set_fund', name: 'IOO', amount: 5000, moneyMarket: true },
      { type: 'set_fund', name: 'IJC', amount: 3000 },
      { type: 'set_bucket', name: 'Kart', amount: 12000 },
    ],
    '2026-11-06',
  );
  assert.equal(deriveView(state, '2026-11-06').moneyMarket.total, 15000);
  state = applyOperations(state, [{ type: 'set_fund', name: 'IOO', amount: 1000 }], '2026-11-06');
  const { moneyMarket } = deriveView(state, '2026-11-06');
  assert.equal(moneyMarket.total, 11000);
  assert.equal(moneyMarket.unallocated, -1000);
});

test('fon değeri pay adedi ve yeni fiyatla güncellenir, maliyet ve işaret korunur', () => {
  const state = applyOperations(
    emptyState(),
    [{ type: 'set_fund', name: 'IOO', amount: 5000, cost: 4900, moneyMarket: true }],
    '2026-11-06',
  );
  const friday = [{ date: '2026-11-06', price: 5 }, { date: '2026-11-05', price: 4.9 }];
  assert.equal(applyFundPrices(state, new Map([['IOO', friday]])), true);
  assert.equal(state.funds[0].units, 1000);
  assert.equal(state.funds[0].value, 5000);

  assert.equal(applyFundPrices(state, new Map([['IOO', friday]])), false);

  const monday = [{ date: '2026-11-09', price: 5.1 }, ...friday];
  assert.equal(applyFundPrices(state, new Map([['IOO', monday]])), true);
  assert.equal(state.funds[0].value, 5100);
  assert.equal(state.funds[0].updatedAt, '2026-11-09');
  assert.equal(state.funds[0].cost, 4900);
  assert.equal(state.funds[0].moneyMarket, true);
});

test('fon değeri elle değişince pay adedi yeniden çıkarılır, TEFAS\'ta olmayan satır dokunulmaz kalır', () => {
  let state = applyOperations(
    emptyState(),
    [
      { type: 'set_fund', name: 'IOO', amount: 100 },
      { type: 'set_fund', name: 'Elle girilen', amount: 500 },
    ],
    '2026-11-06',
  );
  const prices = new Map([['IOO', [{ date: '2026-11-06', price: 10 }]]]);
  applyFundPrices(state, prices);
  assert.equal(state.funds[0].units, 10);
  assert.equal(state.funds[1].units, null);
  assert.equal(state.funds[1].value, 500);

  state = applyOperations(state, [{ type: 'set_fund', name: 'IOO', amount: 200 }], '2026-11-06');
  assert.equal(state.funds[0].units, null);
  applyFundPrices(state, prices);
  assert.equal(state.funds[0].units, 20);
});

function splitMoneyMarket() {
  const state = applyOperations(
    emptyState(),
    [
      { type: 'set_fund', name: 'IOO', amount: 40000, moneyMarket: true },
      { type: 'set_fund', name: 'IJC', amount: 1000 },
      { type: 'set_bucket', name: 'Uzun vade', amount: 15000 },
      { type: 'set_bucket', name: 'Kredi kartı', amount: 15000 },
      { type: 'set_bucket', name: 'Telefon', amount: 5000 },
    ],
    '2026-11-06',
  );
  applyFundPrices(state, new Map([['IOO', [{ date: '2026-11-06', price: 10 }]], ['IJC', [{ date: '2026-11-06', price: 1 }]]]));
  return state;
}

const bucketAmounts = (state) => state.moneyMarket.buckets.map((b) => b.amount);

test('para piyasası getirisi ayırmalara orantılı dağılır, ayrılmamış kısım değişmez', () => {
  const state = splitMoneyMarket();
  assert.deepEqual(bucketAmounts(state), [15000, 15000, 5000]);

  applyFundPrices(state, new Map([['IOO', [{ date: '2026-11-09', price: 10.025 }]]]));

  assert.deepEqual(bucketAmounts(state), [15042.85, 15042.86, 5014.29]);
  const { moneyMarket } = deriveView(state, '2026-11-09');
  assert.equal(moneyMarket.total, 40100);
  assert.equal(moneyMarket.allocated, 35100);
  assert.equal(moneyMarket.unallocated, 5000);
  assert.equal(state.activity[0].amount, 100);
  assert.equal(state.activity[0].date, '2026-11-09');
});

test('aynı fiyat ikinci kez işlenince getiri tekrar dağıtılmaz', () => {
  const state = splitMoneyMarket();
  const monday = new Map([['IOO', [{ date: '2026-11-09', price: 10.025 }]]]);
  applyFundPrices(state, monday);
  const after = bucketAmounts(state);
  applyFundPrices(state, monday);
  assert.deepEqual(bucketAmounts(state), after);
  assert.equal(state.activity.length, 1);
});

test('fiyat düşerse kayıp da ayırmalara yansır, ayrılmamış kısım yine değişmez', () => {
  const state = splitMoneyMarket();
  applyFundPrices(state, new Map([['IOO', [{ date: '2026-11-09', price: 9.975 }]]]));
  const { moneyMarket } = deriveView(state, '2026-11-09');
  assert.equal(moneyMarket.allocated, 34900);
  assert.equal(moneyMarket.unallocated, 5000);
});

test('para piyasası olmayan fonun getirisi ayırmalara dağılmaz', () => {
  const state = splitMoneyMarket();
  applyFundPrices(state, new Map([['IJC', [{ date: '2026-11-09', price: 1.5 }]]]));
  assert.deepEqual(bucketAmounts(state), [15000, 15000, 5000]);
  assert.equal(state.activity.length, 0);
});

test('elle eklenen para getiri sayılmaz, ayrılmamış kısma gider', () => {
  const state = splitMoneyMarket();
  const next = applyOperations(state, [{ type: 'set_fund', name: 'IOO', amount: 41000 }], '2026-11-06');
  applyFundPrices(next, new Map([['IOO', [{ date: '2026-11-06', price: 10 }]]]));
  assert.deepEqual(bucketAmounts(next), [15000, 15000, 5000]);
  assert.equal(deriveView(next, '2026-11-06').moneyMarket.unallocated, 6000);
});

test('ayırma yoksa getiri ayrılmamış kısımda kalır', () => {
  const state = applyOperations(emptyState(), [{ type: 'set_fund', name: 'IOO', amount: 1000, moneyMarket: true }], '2026-11-06');
  applyFundPrices(state, new Map([['IOO', [{ date: '2026-11-06', price: 10 }]]]));
  applyFundPrices(state, new Map([['IOO', [{ date: '2026-11-09', price: 11 }]]]));
  assert.equal(deriveView(state, '2026-11-09').moneyMarket.unallocated, 1100);
  assert.equal(state.activity.length, 0);
});

test('geçmiş fiyatı bulunamayan fonda pay adedi uydurulmaz', () => {
  const state = applyOperations(emptyState(), [{ type: 'set_fund', name: 'IOO', amount: 100 }], '2026-11-01');
  assert.equal(applyFundPrices(state, new Map([['IOO', [{ date: '2026-11-06', price: 10 }]]])), false);
  assert.equal(state.funds[0].value, 100);
});

test('karta bağlı ayırma, borcun ne kadarının karşılandığını gösterir', () => {
  const state = applyOperations(
    emptyState(),
    [
      { type: 'set_card', name: 'Kart A', amount: 18000, statementDay: 18, dueDay: 28 },
      { type: 'set_fund', name: 'IOO', amount: 25000, moneyMarket: true },
      { type: 'set_bucket', name: 'Kart', amount: 15000, cardName: 'kart a' },
    ],
    '2026-11-06',
  );
  const [card] = deriveView(state, '2026-11-06').cards;
  assert.equal(card.reserved, 15000);
  assert.equal(card.shortfall, 3000);
  assert.equal(card.nextDue, '2026-11-28');
  assert.equal(card.daysToDue, 22);
});

test('hisse güncellenir, küçük harf ve .IS kabul edilir, sıfır adet siler', () => {
  let state = applyOperations(emptyState(), [{ type: 'set_holding', symbol: 'thyao.is', quantity: 40, avgCost: 265 }], '2026-11-06');
  assert.deepEqual(state.holdings, [{ symbol: 'THYAO', market: 'BIST', quantity: 40, avgCost: 265 }]);
  state = applyOperations(state, [{ type: 'set_holding', symbol: 'THYAO', quantity: 50, avgCost: null }], '2026-11-06');
  assert.deepEqual(state.holdings, [{ symbol: 'THYAO', market: 'BIST', quantity: 50, avgCost: 265 }]);
  state = applyOperations(state, [{ type: 'set_holding', symbol: 'THYAO', quantity: 0 }], '2026-11-06');
  assert.deepEqual(state.holdings, []);
});

test('Türkçe karakterle yazılan hisse kodu Latin harfe çevrilir', () => {
  for (const typed of ['bimas', 'BİMAS', 'bımas']) {
    const state = applyOperations(emptyState(), [{ type: 'set_holding', symbol: typed, quantity: 1 }], '2026-11-06');
    assert.equal(state.holdings[0].symbol, 'BIMAS');
  }
});

test('ABD hissesi küsuratlı adetini korur ve BIST kaydından ayrı tutulur', () => {
  const state = applyOperations(
    emptyState(),
    [
      { type: 'set_holding', symbol: 'VOO', market: 'US', quantity: 0.123456789, avgCost: 500 },
      { type: 'set_holding', symbol: 'VOO', quantity: 5 },
    ],
    '2026-11-06',
  );
  assert.equal(state.holdings.length, 2);
  assert.equal(state.holdings[0].quantity, 0.123456789);
  assert.throws(() => applyOperations(state, [{ type: 'set_holding', symbol: 'X', market: 'LSE', quantity: 1 }], '2026-11-06'), /Bilinmeyen piyasa/);
});

test('fon değeri güncellenir, tarih tutulur ve toplama girer', () => {
  let state = applyOperations(emptyState(), [{ type: 'set_fund', name: 'IOO', amount: 5000 }], '2026-11-06');
  state = applyOperations(state, [{ type: 'set_fund', name: 'ioo', amount: 13000 }], '2026-11-07');
  state = applyOperations(state, [{ type: 'set_fund', name: 'BGP', amount: 10 }], '2026-11-07');
  assert.equal(state.funds.length, 2);
  assert.equal(state.funds[0].updatedAt, '2026-11-07');
  assert.equal(deriveView(state, '2026-11-07').fundsTotal, 13010);
});

test('geçersiz hisse kodu reddedilir', () => {
  assert.throws(() => applyOperations(emptyState(), [{ type: 'set_holding', symbol: '../x', quantity: 1 }], '2026-11-06'), /Geçersiz/);
});

test('bir işlem hatalıysa önceki işlemler de uygulanmaz', () => {
  const state = emptyState();
  assert.throws(() =>
    applyOperations(
      state,
      [
        { type: 'set_account', name: 'Banka A', amount: 100 },
        { type: 'set_scholarship', name: 'X', amount: 10, day: 40, accountName: 'Banka A' },
      ],
      '2026-11-06',
    ),
  );
  assert.deepEqual(state.accounts, []);
});

test('bugün İstanbul saatine göre hesaplanır', () => {
  assert.equal(todayInIstanbul(new Date('2026-11-30T21:30:00Z')), '2026-12-01');
});
