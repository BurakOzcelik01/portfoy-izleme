import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDueExpenses, applyDueIncomes, applyFundPrices, applyOperations, computeTotals, deriveView, normalizeMarket,
  normalizeState, normalizeSymbol, recordSnapshot, sampleState, todayInIstanbul,
} from './lib/finance.js';
import { getQuotes, symbolExists } from './lib/quotes.js';
import { fetchFundPrices } from './lib/funds.js';
import { loadState, saveState } from './lib/store.js';
import { askAssistant, describeOperation } from './lib/assistant.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);
const DATA_FILE = process.env.DATA_FILE ?? path.join(here, 'data.json');
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const BACKUP_APP = 'portfoy-izleme';

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

let state = normalizeState(loadState(DATA_FILE, () => sampleState(todayInIstanbul())));

const FUND_REFRESH_MS = 30 * 60_000;
let lastFundRefresh = 0;
let fundRefreshError = null;

/** Yeni fon fiyatı varsa işler. Fiyat günde bir kez değiştiği için en fazla 30 dakikada bir sorar. */
async function refreshFundsIfDue() {
  const today = todayInIstanbul();
  const due = state.funds.some((f) => f.units == null || f.prevPrice == null || f.priceDate !== today);
  if (!due || Date.now() - lastFundRefresh < FUND_REFRESH_MS) return;
  lastFundRefresh = Date.now();
  try {
    const prices = await fetchFundPrices(today);
    fundRefreshError = null;
    if (applyFundPrices(state, prices)) persist();
  } catch (error) {
    // Son bilinen değerler ekranda kalır, arayüz uyarı gösterir.
    fundRefreshError = error.message;
    console.error('Fon fiyatları alınamadı:', error.message);
  }
}

function persist() {
  saveState(DATA_FILE, state);
}

/** Vadesi gelen gelir ve giderleri işler; her okumada çalıştığı için ayrı bir zamanlayıcı gerekmez. */
function currentView() {
  const today = todayInIstanbul();
  const applied = applyDueIncomes(state, today).length + applyDueExpenses(state, today).length;
  if (applied > 0) persist();
  return { state, view: deriveView(state, today) };
}

// Bu işlemler fon değerini değiştirir; pay adedi ve fiyat hemen yeniden kontrol edilsin.
const FUND_CHANGING_OPERATIONS = new Set(['set_fund', 'pay_card', 'add_trade', 'remove_trade']);

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

class BadRequest extends Error {}

/** Portföye yeni giren hisse kodunun gerçekten var olduğunu doğrular; var olan kayıtlar sorulmaz. */
async function checkNewHoldings(operations) {
  for (const op of operations) {
    const isNewPosition = op.type === 'set_holding'
      ? op.quantity !== 0
      : op.type === 'add_trade' && op.side === 'buy' && op.kind !== 'FUND';
    if (!isNewPosition) continue;
    let market;
    let symbol;
    try {
      market = normalizeMarket(op.type === 'add_trade' ? op.kind : op.market);
      symbol = normalizeSymbol(op.symbol, market);
    } catch (error) {
      throw new BadRequest(error.message);
    }
    if (state.holdings.some((h) => h.symbol === symbol && h.market === market)) continue;
    const place = market === 'US' ? "ABD'de" : "Borsa İstanbul'da";
    let exists;
    try {
      exists = await symbolExists(symbol, market);
    } catch {
      throw new BadRequest(`${symbol} kodu şu an doğrulanamadı, hisse eklenmedi. Biraz sonra tekrar dene.`);
    }
    if (!exists) throw new BadRequest(`${place} ${symbol} kodlu bir hisse bulunamadı, eklenmedi. Kodu kontrol et.`);
  }
}

async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new BadRequest('JSON bekleniyor');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('İstek çok büyük');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('Geçersiz JSON');
  }
}

async function handleApi(req, res, pathname) {
  const route = `${req.method} ${pathname}`;
  switch (route) {
    case 'GET /api/state':
      return sendJson(res, 200, currentView());

    case 'GET /api/quotes': {
      await refreshFundsIfDue();
      const market = await getQuotes(state.holdings);
      const current = currentView();
      const totals = computeTotals(state, market);
      if (recordSnapshot(state, todayInIstanbul(), totals)) persist();
      return sendJson(res, 200, { ...market, ...current, totals, fundRefreshError });
    }

    case 'GET /api/backup': {
      const today = todayInIstanbul();
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="portfoy-yedek-${today}.json"`,
        'cache-control': 'no-store',
      });
      return res.end(JSON.stringify({ app: BACKUP_APP, version: 1, exportedAt: new Date().toISOString(), state }, null, 2));
    }

    case 'POST /api/restore': {
      const { backup } = await readJson(req);
      if (backup?.app !== BACKUP_APP) throw new BadRequest('Bu dosya bu uygulamanın yedeği değil');
      let restored;
      try {
        restored = normalizeState(backup.state);
      } catch (error) {
        throw new BadRequest(error.message);
      }
      // Yanlış dosya seçilirse geri dönülebilsin diye mevcut veri kenara alınır.
      saveState(DATA_FILE.replace(/\.json$/, '.before-restore.json'), state);
      state = restored;
      persist();
      lastFundRefresh = 0;
      return sendJson(res, 200, currentView());
    }

    case 'POST /api/operations': {
      const { operations, source } = await readJson(req);
      if (!Array.isArray(operations) || operations.length === 0) throw new BadRequest('İşlem listesi boş');
      await checkNewHoldings(operations);
      const today = todayInIstanbul();
      let next;
      try {
        next = applyOperations(state, operations, today);
      } catch (error) {
        throw new BadRequest(error.message);
      }
      if (source === 'assistant') {
        for (const op of operations) {
          next.activity.unshift({ id: randomUUID(), date: today, text: `Asistan: ${describeOperation(op)}`, amount: null });
        }
      }
      state = next;
      persist();
      if (operations.some((op) => FUND_CHANGING_OPERATIONS.has(op.type))) lastFundRefresh = 0;
      return sendJson(res, 200, currentView());
    }

    case 'POST /api/assistant': {
      const body = await readJson(req);
      currentView();
      try {
        return sendJson(res, 200, await askAssistant(body, state, todayInIstanbul()));
      } catch (error) {
        if (error instanceof RangeError) throw new BadRequest(error.message);
        throw error;
      }
    }

    default:
      return sendJson(res, 404, { error: 'Bulunamadı' });
  }
}

const server = createServer(async (req, res) => {
  // Başka bir sitenin tarayıcı üzerinden bu yerel sunucuya erişmesini engeller.
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') {
    res.writeHead(403);
    return res.end();
  }
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    const file = STATIC_FILES[pathname];
    if (req.method !== 'GET' || !file) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache' });
    return res.end(await readFile(path.join(here, 'public', file[0])));
  } catch (error) {
    if (error instanceof BadRequest) return sendJson(res, 400, { error: error.message });
    console.error(error);
    return sendJson(res, 500, { error: 'Beklenmeyen bir hata oluştu' });
  }
});

// Veriler kişisel olduğu için yalnızca bu bilgisayardan erişilebilir.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Portföy uygulaması: http://localhost:${PORT}`);
});
