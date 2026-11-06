import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolExists } from '../lib/quotes.js';

function yahoo(status, currency = 'TRY') {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return new Response(
      JSON.stringify(status === 200 ? { chart: { result: [{ meta: { regularMarketPrice: 10, currency } }] } } : {}),
      { status },
    );
  };
  return { fetchImpl, urls };
}

test('var olan BIST hissesi kabul edilir ve .IS ekiyle sorulur', async () => {
  const { fetchImpl, urls } = yahoo(200);
  assert.equal(await symbolExists('AKSA', 'BIST', fetchImpl), true);
  assert.match(urls[0], /AKSA\.IS/);
});

test('Yahoo 404 dönerse hisse yok sayılır', async () => {
  assert.equal(await symbolExists('AKS', 'BIST', yahoo(404).fetchImpl), false);
});

test('ABD hissesi eksiz sorulur, para birimi uymuyorsa yok sayılır', async () => {
  const { fetchImpl, urls } = yahoo(200, 'USD');
  assert.equal(await symbolExists('VOO', 'US', fetchImpl), true);
  assert.match(urls[0], /chart\/VOO\?/);
  assert.equal(await symbolExists('XYZ', 'US', yahoo(200, 'EUR').fetchImpl), false);
});

test('Yahoo geçici hata verirse "yok" denmez, hata fırlatılır', async () => {
  await assert.rejects(symbolExists('THYAO', 'BIST', yahoo(503).fetchImpl), /Yahoo 503/);
});
