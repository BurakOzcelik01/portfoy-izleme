import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFundPrices } from '../lib/funds.js';

const respond = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test('fiyatlar koda göre yeniden eskiye sıralanır, geçersiz fiyat atlanır', async () => {
  const prices = await fetchFundPrices('2026-11-06', respond({
    resultList: [
      { fonKodu: 'IOO', tarih: '2026-11-05', fiyat: 4.96 },
      { fonKodu: 'IOO', tarih: '2026-11-06', fiyat: 4.97 },
      { fonKodu: 'ZBJ', tarih: '2026-11-06', fiyat: 0 },
    ],
  }));
  assert.deepEqual(prices.get('IOO'), [{ date: '2026-11-06', price: 4.97 }, { date: '2026-11-05', price: 4.96 }]);
  assert.equal(prices.has('ZBJ'), false);
});

test('istek bir haftalık aralığı sorar', async () => {
  let sent;
  await fetchFundPrices('2026-11-06', async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ resultList: [] }));
  });
  assert.equal(sent.basTarih, '20261030');
  assert.equal(sent.bitTarih, '20261106');
});

test('TEFAS hata verirse boş sonuç sayılmaz, hata fırlatılır', async () => {
  await assert.rejects(fetchFundPrices('2026-11-06', respond({}, 503)), /TEFAS 503/);
  await assert.rejects(fetchFundPrices('2026-11-06', respond({ resultList: null, errorMessage: 'Kapalı' })), /Kapalı/);
});
