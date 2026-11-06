const QUOTE_REFRESH_MS = 30_000;
const STATE_REFRESH_MS = 5 * 60_000;
const MAX_IMAGE_SIDE = 1568;
const MAX_IMAGES = 10;

let data = null; // { state, view }
let quotes = new Map();
let usdTry = null;
let fundRefreshError = null;
let quotesLoadedAt = null;
let attachments = []; // { data, mediaType, url }
const history = [];

const $ = (id) => document.getElementById(id);

/** Tüm metinler textContent ile eklenir; fotoğraftan veya asistandan gelen yazı HTML olarak işlenmez. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'style') el.style.cssText = value;
    else if (value !== null && value !== undefined && value !== false) el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const moneyFormat = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' });
const dollarFormat = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'USD' });
const money = (value) => moneyFormat.format(value);
const dollars = (value) => dollarFormat.format(value);
const number = (value) => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 6 }).format(value);
const signed = (format, value) => `${value > 0 ? '+' : ''}${format(value)}`;
const signedMoney = (value) => signed(money, value);
const percent = (value) => {
  const digits = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value));
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}%${digits}`;
};
/** Kâr/zarar hücresi: tutar ve altında maliyete göre yüzde. Maliyet yoksa yüzde gösterilmez. */
const pnlCell = (format, pnl, cost) => [
  signed(format, pnl),
  cost > 0 ? h('span', { class: 'pct' }, percent((pnl / cost) * 100)) : null,
];
// Türkçe ek son rakamın okunuşuna göre değişir: 1'i, 2'si, 6'sı, 10'u, 20'si, 30'u.
const DAY_SUFFIX = { 1: "'i", 2: "'si", 3: "'ü", 4: "'ü", 5: "'i", 6: "'sı", 7: "'si", 8: "'i", 9: "'u" };
const TENS_SUFFIX = { 10: "'u", 20: "'si", 30: "'u" };
const dayLabel = (day) => `${day}${TENS_SUFFIX[day] ?? DAY_SUFFIX[day % 10]}`;
const longDate = (iso) =>
  new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
const clock = (ms) =>
  new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' }).format(ms);

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? 'Sunucu hatası');
  return payload;
}

/* ---------- Görünüm ---------- */

function holdingRows() {
  return data.state.holdings.map((holding) => {
    const quote = quotes.get(`${holding.market}:${holding.symbol}`);
    const price = quote?.price ?? null;
    const value = price === null ? null : price * holding.quantity;
    const pnl = value !== null && holding.avgCost != null ? value - holding.avgCost * holding.quantity : null;
    const cost = holding.avgCost == null ? null : holding.avgCost * holding.quantity;
    let valueTry = value;
    if (holding.market === 'US') valueTry = value === null || usdTry === null ? null : value * usdTry;
    return { ...holding, quote, price, value, valueTry, pnl, cost };
  });
}

function changeClass(value) {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return '';
}

function renderHero(rows) {
  const { view } = data;
  const priced = rows.filter((r) => r.valueTry !== null);
  const stocks = priced.reduce((sum, r) => sum + r.valueTry, 0);
  const missing = rows.length - priced.length;
  // Para piyasası fonları da fon toplamının içindedir; özet satırında ayrı gösterilir, iki kez sayılmaz.
  const net = view.cashTotal + stocks + view.fundsTotal - view.debtTotal;

  $('net-worth').textContent = money(net);
  $('net-note').textContent = missing > 0 && quotesLoadedAt
    ? `Fiyatı alınamayan ${missing} hisse bu toplama dahil değil.`
    : '';
  $('hero-parts').replaceChildren(
    ...[
      ['Banka', money(view.cashTotal)],
      ['Hisseler', money(stocks)],
      ['Diğer fonlar', money(view.fundsTotal - view.moneyMarket.total)],
      ['Para piyasası', money(view.moneyMarket.total)],
      ['Kart borcu', view.debtTotal > 0 ? `−${money(view.debtTotal)}` : money(0)],
    ].flatMap(([label, value]) => [h('div', {}, h('dt', {}, label), h('dd', {}, value))]),
  );
}

function renderHoldings(rows, { boxId, statusId, format, editorKind }) {
  const box = $(boxId);
  if (rows.length === 0) {
    box.replaceChildren(h('p', { class: 'empty' }, 'Henüz hisse yok. Aracı kurum ekran görüntüsünü aşağıdan yükleyebilirsin.'));
    $(statusId).textContent = '';
    return;
  }
  const total = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  const totalPnl = rows.reduce((sum, r) => sum + (r.pnl ?? 0), 0);
  const totalCost = rows.reduce((sum, r) => sum + (r.pnl === null ? 0 : r.cost), 0);
  const anyPnl = rows.some((r) => r.pnl !== null);

  const body = rows.map((r) =>
    h('tr', { onclick: () => openEditor(editorKind, r), title: 'Düzenlemek için tıkla' },
      h('td', {}, h('button', { type: 'button', class: 'symbol' }, r.symbol)),
      h('td', { class: 'num hide-narrow' }, number(r.quantity)),
      h('td', { class: 'num' },
        r.price === null ? '—' : format(r.price),
        r.quote?.stale && r.price !== null ? [' ', h('span', { class: 'stale', title: 'Güncel fiyat alınamadı, son bilinen fiyat' }, 'eski')] : null),
      h('td', { class: `num ${changeClass(r.quote?.changePercent ?? 0)}` }, r.quote?.changePercent == null ? '—' : percent(r.quote.changePercent)),
      h('td', { class: 'num' }, r.value === null ? '—' : format(r.value)),
      h('td', { class: `num hide-narrow ${changeClass(r.pnl ?? 0)}` }, r.pnl === null ? '—' : pnlCell(format, r.pnl, r.cost)),
    ));

  box.replaceChildren(h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Hisse'),
        h('th', { class: 'hide-narrow' }, 'Adet'),
        h('th', {}, 'Fiyat'),
        h('th', {}, 'Günlük'),
        h('th', {}, 'Değer'),
        h('th', { class: 'hide-narrow' }, 'Kâr/Zarar'))),
      h('tbody', {}, body),
      h('tfoot', {}, h('tr', {},
        h('td', {}, 'Toplam'),
        h('td', { class: 'hide-narrow' }),
        h('td', {}),
        h('td', {}),
        h('td', { class: 'num' }, format(total)),
        h('td', { class: `num hide-narrow ${changeClass(totalPnl)}` }, anyPnl ? pnlCell(format, totalPnl, totalCost) : '—'))))));

  const times = rows.map((r) => r.quote?.marketTime).filter(Boolean);
  const latest = times.length ? Math.max(...times) : null;
  const rate = format === dollars && usdTry !== null
    ? ` Toplam ${money(total * usdTry)} (1 $ = ${money(usdTry)}).`
    : '';
  $(statusId).textContent = quotesLoadedAt
    ? `Fiyatlar 30 saniyede bir yenilenir.${latest ? ` Son işlem saati: ${clock(latest)}.` : ''}${rate} Kaynak: Yahoo Finance, gecikmeli olabilir.`
    : 'Fiyatlar yükleniyor…';
}

function renderFunds() {
  const { funds } = data.state;
  $('funds').replaceChildren(...(funds.length ? funds.map((fund) => {
    const pnl = fund.cost == null ? null : fund.value - fund.cost;
    return h('li', {}, h('button', { type: 'button', class: 'row', onclick: () => openEditor('fund', fund) },
      h('span', {},
        h('span', { class: 'row-title' }, fund.name),
        h('span', { class: 'row-sub' }, `${fund.moneyMarket ? 'Para piyasası · ' : ''}${longDate(fund.updatedAt)} değeri`)),
      h('span', { class: 'num' },
        money(fund.value),
        pnl === null ? null : h('span', { class: `pct ${changeClass(pnl)}` }, `${percent((pnl / fund.cost) * 100)} (${signedMoney(pnl)})`))));
  }) : [emptyRow('Henüz fon yok.')]));

  const known = funds.filter((f) => f.cost != null);
  const totalCost = known.reduce((sum, f) => sum + f.cost, 0);
  const totalPnl = known.reduce((sum, f) => sum + f.value - f.cost, 0);
  const parts = [`Toplam ${money(data.view.fundsTotal)}.`];
  if (totalCost > 0) {
    const scope = known.length < funds.length ? ', maliyeti bilinen fonlarda' : '';
    parts.push(`Toplam kâr/zarar ${percent((totalPnl / totalCost) * 100)} (${signedMoney(totalPnl)}${scope}).`);
  }
  parts.push(fundRefreshError
    ? `TEFAS'tan fiyat alınamadı, son bilinen değerler gösteriliyor (${fundRefreshError}).`
    : 'Değerler TEFAS fiyatıyla günde bir kez güncellenir.');
  $('funds-status').textContent = funds.length ? parts.join(' ') : '';
}

function renderMoneyMarket() {
  const { moneyMarket: mm } = data.view;
  const color = (index) => `var(--seg-${(index % 8) + 1})`;
  const parts = [];
  if (mm.total > 0) {
    mm.buckets.forEach((bucket, index) => {
      if (bucket.amount > 0) {
        parts.push(h('div', { class: 'segment', title: `${bucket.name}: ${money(bucket.amount)}`, style: `flex:${bucket.amount};background:${color(index)}` }));
      }
    });
    if (mm.unallocated > 0) {
      parts.push(h('div', { class: 'segment', title: `Ayrılmamış: ${money(mm.unallocated)}`, style: `flex:${mm.unallocated};background:var(--seg-free)` }));
    }
  }

  const rows = mm.buckets.map((bucket, index) => {
    const card = data.view.cards.find((c) => c.id === bucket.cardId);
    return h('li', {}, h('button', { type: 'button', class: 'row', onclick: () => openEditor('bucket', { ...bucket, cardName: card?.name ?? '' }) },
      h('span', {},
        h('span', { class: 'swatch', style: `background:${color(index)}` }),
        h('span', { class: 'row-title' }, bucket.name),
        card ? h('span', { class: 'row-sub' }, `${card.name} için`) : null),
      h('span', { class: 'num' }, money(bucket.amount))));
  });
  if (mm.unallocated !== 0 || mm.buckets.length === 0) {
    rows.push(h('li', {}, h('div', { class: 'row' },
      h('span', {}, h('span', { class: 'swatch', style: 'background:var(--seg-free)' }), h('span', { class: 'row-title' }, mm.unallocated < 0 ? 'Ayrılandan eksik' : 'Ayrılmamış')),
      h('span', { class: 'num' }, money(mm.unallocated)))));
  }
  if (mm.total === 0 && mm.buckets.length === 0) {
    rows.push(emptyRow('Fonlar bölümünde bir fonu para piyasası olarak işaretleyince tutar buraya gelir.'));
  }

  $('money-market').replaceChildren(
    h('div', { class: 'mm-total' }, h('span', { class: 'muted' }, 'Toplam'), h('strong', {}, money(mm.total))),
    ...(parts.length ? [h('div', { class: 'segments', role: 'img', 'aria-label': 'Para piyasası dağılımı; ayrıntılar aşağıdaki listede' }, parts)] : []),
    h('ul', { class: 'rows' }, rows),
  );
}

function emptyRow(text) {
  return h('li', {}, h('p', { class: 'empty' }, text));
}

function renderAccounts() {
  const { accounts } = data.state;
  $('accounts').replaceChildren(...(accounts.length ? accounts.map((account) =>
    h('li', {}, h('button', { type: 'button', class: 'row', onclick: () => openEditor('account', account) },
      h('span', { class: 'row-title' }, account.name),
      h('span', { class: 'num' }, money(account.balance))))) : [emptyRow('Henüz hesap yok.')]));
}

function dueLabel(card) {
  if (card.debt === 0) return h('span', { class: 'pill ok' }, 'Borç yok');
  if (card.daysToDue === 0) return h('span', { class: 'pill' }, 'Son ödeme bugün');
  if (card.daysToDue <= 7) return h('span', { class: 'pill' }, `Son ödemeye ${card.daysToDue} gün`);
  return null;
}

function coverageLabel(card) {
  if (card.debt === 0 || card.reserved === 0) return null;
  return card.shortfall === 0
    ? h('span', { class: 'pill ok' }, 'Para piyasasında ayrılan tutar borcu karşılıyor')
    : h('span', { class: 'pill' }, `Para piyasasında ayrılan tutarın ${money(card.shortfall)} eksiği var`);
}

function renderCards() {
  const { cards } = data.view;
  $('cards').replaceChildren(...(cards.length ? cards.map((card) =>
    h('li', {}, h('button', { type: 'button', class: 'row', onclick: () => openEditor('card', card) },
      h('span', {},
        h('span', { class: 'row-title' }, card.name),
        h('span', { class: 'row-sub' }, `Kesim ${longDate(card.nextStatement)} · Son ödeme ${longDate(card.nextDue)}`),
        dueLabel(card), card.debt > 0 && dueLabel(card) && coverageLabel(card) ? ' ' : null, coverageLabel(card)),
      h('span', { class: 'num' }, money(card.debt))))) : [emptyRow('Henüz kart yok.')]));
}

function renderIncomes() {
  const { incomes } = data.view;
  $('incomes').replaceChildren(...(incomes.length ? incomes.map((s) =>
    h('li', {}, h('button', { type: 'button', class: 'row', onclick: () => openEditor('income', s) },
      h('span', {},
        h('span', { class: 'row-title' }, s.name),
        h('span', { class: 'row-sub' }, `Her ayın ${dayLabel(s.day)} → ${s.accountName}`),
        h('span', { class: 'row-sub' }, `Sonraki yatış: ${longDate(s.nextDate)} (${s.daysToNext} gün)`)),
      h('span', { class: 'num' }, money(s.amount))))) : [emptyRow('Henüz gelir yok.')]));
}

function renderNotes() {
  const { notes } = data.state;
  $('notes').replaceChildren(...(notes.length ? notes.map((note) =>
    h('li', {}, h('div', { class: 'row' },
      h('span', {}, note.text, note.date ? h('span', { class: 'row-sub' }, longDate(note.date)) : null),
      h('button', { type: 'button', class: 'ghost', 'aria-label': 'Notu sil', onclick: () => submitOperations([{ type: 'remove_note', id: note.id }]) }, 'Sil')))) : [emptyRow('Not yok.')]));
}

function renderActivity() {
  const items = data.state.activity.slice(0, 12);
  $('activity').replaceChildren(...(items.length ? items.map((item) =>
    h('li', {}, h('div', { class: 'row' },
      h('span', {}, item.text, h('span', { class: 'row-sub' }, longDate(item.date))),
      item.amount != null ? h('span', { class: `num ${changeClass(item.amount)}` }, signedMoney(item.amount)) : null))) : [emptyRow('Gelir yatışları ve asistan güncellemeleri burada görünür.')]));
}

function render() {
  if (!data) return;
  const rows = holdingRows();
  $('sample-banner').hidden = !data.state.isSample;
  renderHero(rows);
  renderHoldings(rows.filter((r) => r.market === 'BIST'), { boxId: 'holdings', statusId: 'quote-status', format: money, editorKind: 'holding' });
  renderHoldings(rows.filter((r) => r.market === 'US'), { boxId: 'us-holdings', statusId: 'us-status', format: dollars, editorKind: 'usHolding' });
  renderFunds();
  renderMoneyMarket();
  renderAccounts();
  renderCards();
  renderIncomes();
  renderNotes();
  renderActivity();
}

/* ---------- Veri ---------- */

async function loadState() {
  data = await api('/api/state');
  render();
}

async function loadQuotes() {
  if (!data) return;
  const result = await api('/api/quotes');
  quotes = new Map(result.quotes.map((q) => [`${q.market}:${q.symbol}`, q]));
  usdTry = result.usdTry;
  // Fon fiyatı bu istekle güncellenmiş olabilir.
  data = { state: result.state, view: result.view };
  fundRefreshError = result.fundRefreshError;
  quotesLoadedAt = Date.now();
  render();
}

async function submitOperations(operations, source = 'manual') {
  data = await api('/api/operations', { operations, source });
  render();
  loadQuotes().catch(() => {});
}

/* ---------- Elle düzenleme ---------- */

const EDITORS = {
  holding: {
    title: 'Hisse',
    key: 'symbol',
    fields: () => [
      { name: 'symbol', label: 'BIST kodu', type: 'text', required: true, keyField: true },
      { name: 'quantity', label: 'Adet', type: 'number', required: true },
      { name: 'avgCost', label: 'Ortalama maliyet (TL)', type: 'number', hint: 'Kâr/zarar için, boş bırakabilirsin' },
    ],
    save: (v) => ({ type: 'set_holding', market: 'BIST', symbol: v.symbol, quantity: v.quantity, avgCost: v.avgCost }),
    remove: (v) => ({ type: 'remove_holding', market: 'BIST', symbol: v.symbol }),
  },
  usHolding: {
    title: 'ABD hissesi',
    key: 'symbol',
    fields: () => [
      { name: 'symbol', label: 'Hisse kodu', type: 'text', required: true, keyField: true },
      { name: 'quantity', label: 'Adet (küsuratlı olabilir)', type: 'number', required: true },
      { name: 'avgCost', label: 'Ortalama maliyet ($)', type: 'number', hint: 'Kâr/zarar için, boş bırakabilirsin' },
    ],
    save: (v) => ({ type: 'set_holding', market: 'US', symbol: v.symbol, quantity: v.quantity, avgCost: v.avgCost }),
    remove: (v) => ({ type: 'remove_holding', market: 'US', symbol: v.symbol }),
  },
  fund: {
    title: 'Yatırım fonu',
    key: 'name',
    fields: () => [
      { name: 'name', label: 'Fon kodu', type: 'text', required: true, keyField: true },
      { name: 'value', label: 'Güncel değer (TL)', type: 'number', required: true, hint: 'Sonraki günlerde TEFAS fiyatıyla kendiliğinden güncellenir' },
      { name: 'cost', label: 'Toplam maliyet (TL)', type: 'number', hint: 'Kâr/zarar için, boş bırakabilirsin. Fon alıp satınca güncelle.' },
      { name: 'moneyMarket', label: 'Para piyasası fonu', type: 'checkbox' },
    ],
    save: (v) => ({ type: 'set_fund', name: v.name, amount: v.value, cost: v.cost, moneyMarket: v.moneyMarket }),
    remove: (v) => ({ type: 'remove_fund', name: v.name }),
  },
  account: {
    title: 'Banka hesabı',
    key: 'name',
    fields: () => [
      { name: 'name', label: 'Hesap adı', type: 'text', required: true, keyField: true },
      { name: 'balance', label: 'Bakiye (TL)', type: 'number', required: true, min: null },
    ],
    save: (v) => ({ type: 'set_account', name: v.name, amount: v.balance }),
    remove: (v) => ({ type: 'remove_account', name: v.name }),
  },
  card: {
    title: 'Kredi kartı',
    key: 'name',
    fields: () => [
      { name: 'name', label: 'Kart adı', type: 'text', required: true, keyField: true },
      { name: 'debt', label: 'Borç (TL)', type: 'number', required: true },
      { name: 'statementDay', label: 'Kesim günü (ayın kaçı)', type: 'day', required: true },
      { name: 'dueDay', label: 'Son ödeme günü (ayın kaçı)', type: 'day', required: true },
    ],
    save: (v) => ({ type: 'set_card', name: v.name, amount: v.debt, statementDay: v.statementDay, dueDay: v.dueDay }),
    remove: (v) => ({ type: 'remove_card', name: v.name }),
  },
  income: {
    title: 'Gelir',
    key: 'name',
    fields: () => [
      { name: 'name', label: 'Gelir adı', type: 'text', required: true, keyField: true, hint: 'Örneğin: Maaş, Burs, Kira' },
      { name: 'amount', label: 'Aylık tutar (TL)', type: 'number', required: true },
      { name: 'day', label: 'Yatış günü (ayın kaçı)', type: 'day', required: true, hint: 'O gün gelince tutar hesaba kendiliğinden eklenir' },
      { name: 'accountName', label: 'Yatacağı hesap', type: 'select', required: true, options: data.state.accounts.map((a) => [a.name, a.name]) },
    ],
    save: (v) => ({ type: 'set_income', name: v.name, amount: v.amount, day: v.day, accountName: v.accountName }),
    remove: (v) => ({ type: 'remove_income', name: v.name }),
  },
  bucket: {
    title: 'Para piyasasından ayır',
    key: 'name',
    fields: () => [
      { name: 'name', label: 'Ne için?', type: 'text', required: true, keyField: true, hint: 'Örneğin: Uzun vade, Kredi kartı ödemesi' },
      { name: 'amount', label: 'Tutar (TL)', type: 'number', required: true, hint: `Ayrılmamış: ${money(data.view.moneyMarket.unallocated)}` },
      { name: 'cardName', label: 'Bağlı kart', type: 'select', options: [['', 'Yok'], ...data.state.cards.map((c) => [c.name, c.name])] },
    ],
    save: (v) => ({ type: 'set_bucket', name: v.name, amount: v.amount, cardName: v.cardName ?? '' }),
    remove: (v) => ({ type: 'remove_bucket', name: v.name }),
  },
  note: {
    title: 'Not',
    fields: () => [
      { name: 'text', label: 'Not', type: 'text', required: true },
      { name: 'date', label: 'Tarih (isteğe bağlı)', type: 'date' },
    ],
    save: (v) => ({ type: 'add_note', text: v.text, date: v.date }),
  },
};

let editing = null;

function fieldInput(field, value) {
  if (field.type === 'select') {
    return h('select', { name: field.name, required: field.required },
      field.options.map(([optionValue, label]) => h('option', { value: optionValue, selected: optionValue === (value ?? '') }, label)));
  }
  if (field.type === 'checkbox') {
    return h('input', { type: 'checkbox', name: field.name, checked: Boolean(value) });
  }
  const attrs = { name: field.name, required: field.required, value: value ?? '' };
  if (field.type === 'number') {
    Object.assign(attrs, { type: 'number', step: 'any', inputmode: 'decimal', min: field.min === null ? null : 0 });
  } else if (field.type === 'day') {
    Object.assign(attrs, { type: 'number', step: 1, min: 1, max: 31, inputmode: 'numeric' });
  } else if (field.type === 'date') {
    attrs.type = 'date';
  } else {
    attrs.type = 'text';
    attrs.autocomplete = 'off';
  }
  return h('input', attrs);
}

let deleteArmed = false;

function disarmDelete() {
  deleteArmed = false;
  $('editor-delete').textContent = 'Sil';
}

function openEditor(kind, record = null) {
  const config = EDITORS[kind];
  const values = record ?? config.defaults?.() ?? {};
  const fields = config.fields();
  editing = { kind, config, record };
  $('editor-title').textContent = record ? `${config.title}: ${record[config.key]}` : config.title;
  const needsAccount = kind === 'income' && fields[3].options.length === 0;
  $('editor-error').textContent = needsAccount ? 'Gelir eklemeden önce yatacağı banka hesabını ekle.' : '';
  $('editor-error').hidden = !needsAccount;
  $('editor-delete').hidden = !(record && config.remove);
  disarmDelete();
  $('editor-fields').replaceChildren(...fields.map((field) => {
    const input = fieldInput(field, values[field.name]);
    // Kayıtlar adla eşleşir; düzenlerken ad değişirse yeni kayıt oluşurdu.
    if (record && field.keyField) input.readOnly = true;
    if (field.type === 'checkbox') return h('label', { class: 'field field-check' }, input, field.label);
    return h('label', { class: 'field' }, field.label, input, field.hint ? h('small', {}, field.hint) : null);
  }));
  $('editor').showModal();
}

function readEditor() {
  const form = new FormData($('editor-form'));
  const values = {};
  for (const field of editing.config.fields()) {
    const raw = String(form.get(field.name) ?? '').trim();
    if (field.type === 'checkbox') values[field.name] = form.has(field.name);
    else if (field.type === 'number' || field.type === 'day') values[field.name] = raw === '' ? null : Number(raw);
    else values[field.name] = raw === '' ? null : raw;
  }
  return values;
}

async function runEditor(operation) {
  try {
    await submitOperations([operation]);
    $('editor').close();
  } catch (error) {
    $('editor-error').textContent = error.message;
    $('editor-error').hidden = false;
  }
}

$('editor-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runEditor(editing.config.save(readEditor()));
});
$('editor-cancel').addEventListener('click', () => $('editor').close());
// Onay pencerenin içinde istenir: window.confirm her tarayıcıda açılmaz, açılmayınca da silme sessizce iptal olur.
$('editor-delete').addEventListener('click', () => {
  if (deleteArmed) {
    runEditor(editing.config.remove(editing.record));
    disarmDelete();
  } else {
    deleteArmed = true;
    $('editor-delete').textContent = 'Eminim, sil';
  }
});
document.querySelectorAll('[data-add]').forEach((button) => {
  button.addEventListener('click', () => openEditor(button.dataset.add));
});
$('dismiss-sample').addEventListener('click', () => {
  submitOperations([{ type: 'dismiss_sample' }]);
});

/* ---------- Asistan ---------- */

function addMessage(node) {
  $('thread').hidden = false;
  $('messages').append(node);
  $('thread').scrollTop = $('thread').scrollHeight;
  return node;
}

function renderProposal(result) {
  const applyButton = h('button', { type: 'button', class: 'send', disabled: Boolean(result.validationError) }, 'Uygula');
  const dismissButton = h('button', { type: 'button', class: 'ghost' }, 'Vazgeç');
  const status = h('span', { class: 'muted small', role: 'status' });
  const box = h('div', { class: 'proposal' },
    h('ul', {}, result.descriptions.map((text) => h('li', {}, text))),
    result.validationError ? h('p', { class: 'form-error' }, `Bu öneri uygulanamaz: ${result.validationError}`) : null,
    h('div', { class: 'proposal-actions' }, applyButton, dismissButton, status));

  const finish = (text) => {
    applyButton.remove();
    dismissButton.remove();
    status.textContent = text;
  };
  dismissButton.addEventListener('click', () => finish('Vazgeçildi, değişiklik yapılmadı.'));
  applyButton.addEventListener('click', async () => {
    applyButton.disabled = true;
    try {
      await submitOperations(result.operations, 'assistant');
      finish('Uygulandı.');
    } catch (error) {
      applyButton.disabled = false;
      status.textContent = error.message;
    }
  });
  return box;
}

async function prepareImage(file) {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} bir fotoğraf değil`);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} açılamadı. HEIC ise JPEG veya PNG olarak kaydedip tekrar dene.`);
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = canvas.toDataURL('image/jpeg', 0.9);
  return { url, mediaType: 'image/jpeg', data: url.split(',')[1] };
}

function renderAttachments() {
  const box = $('attachments');
  box.hidden = attachments.length === 0;
  box.replaceChildren(...attachments.map((attachment, index) =>
    h('div', { class: 'attachment' },
      h('img', { src: attachment.url, alt: `Yüklenen fotoğraf ${index + 1}` }),
      h('button', {
        type: 'button',
        'aria-label': `Fotoğraf ${index + 1} kaldır`,
        onclick: () => { attachments.splice(index, 1); renderAttachments(); },
      }, '×'))));
}

async function addFiles(files) {
  for (const file of files) {
    if (attachments.length >= MAX_IMAGES) {
      addMessage(h('p', { class: 'message' }, `En fazla ${MAX_IMAGES} fotoğraf ekleyebilirsin.`));
      break;
    }
    try {
      attachments.push(await prepareImage(file));
    } catch (error) {
      addMessage(h('p', { class: 'message' }, error.message));
    }
  }
  renderAttachments();
}

function resizePrompt() {
  const prompt = $('prompt');
  prompt.style.height = 'auto';
  prompt.style.height = `${prompt.scrollHeight}px`;
}

async function sendMessage() {
  const prompt = $('prompt');
  const text = prompt.value.trim();
  if (!text && attachments.length === 0) return;

  const images = attachments;
  attachments = [];
  prompt.value = '';
  resizePrompt();
  renderAttachments();

  addMessage(h('div', { class: 'message user' },
    images.length ? h('div', { class: 'message-images' }, images.map((image) => h('img', { src: image.url, alt: 'Gönderilen fotoğraf' }))) : null,
    text));
  const pending = addMessage(h('p', { class: 'message muted' }, 'Bakıyorum…'));
  $('send').disabled = true;

  const userText = text || '(fotoğraf yükledi)';
  try {
    const result = await api('/api/assistant', {
      text,
      images: images.map(({ data: imageData, mediaType }) => ({ data: imageData, mediaType })),
      history,
    });
    pending.className = 'message';
    pending.textContent = result.reply;
    if (result.operations.length > 0) addMessage(renderProposal(result));
    history.push({ role: 'user', text: userText }, { role: 'assistant', text: result.reply });
  } catch (error) {
    pending.className = 'message';
    pending.textContent = error.message;
  } finally {
    $('send').disabled = false;
    prompt.focus();
  }
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});
$('prompt').addEventListener('input', resizePrompt);
$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});
$('file-input').addEventListener('change', async (event) => {
  await addFiles([...event.target.files]);
  event.target.value = '';
});
$('thread-close').addEventListener('click', () => { $('thread').hidden = true; });
document.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) addFiles(files);
});
for (const type of ['dragover', 'dragenter']) {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    $('composer').classList.add('dragging');
  });
}
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) $('composer').classList.remove('dragging');
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  $('composer').classList.remove('dragging');
  addFiles([...event.dataTransfer.files]);
});

/* ---------- Başlangıç ---------- */

function reportLoadError(error) {
  $('net-note').textContent = `Veriler yüklenemedi: ${error.message}`;
}

await loadState().catch(reportLoadError);
render();
loadQuotes().catch(() => { quotesLoadedAt = Date.now(); render(); });
setInterval(() => {
  if (!document.hidden) loadQuotes().catch(() => {});
}, QUOTE_REFRESH_MS);
// Gelirler sunucuda işlenir; açık kalan sayfa da gün dönümünü yakalar.
setInterval(() => loadState().catch(() => {}), STATE_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    loadState().then(loadQuotes).catch(() => {});
  }
});
