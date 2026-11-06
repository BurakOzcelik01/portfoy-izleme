import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { askAssistant, cleanOperation, describeOperation } from '../lib/assistant.js';
import { applyOperations, emptyState } from '../lib/finance.js';

const TODAY = '2026-11-06';
const NULL_FIELDS = {
  symbol: null, quantity: null, avgCost: null, name: null, amount: null,
  statementDay: null, dueDay: null, day: null, accountName: null, cardName: null, text: null, date: null,
};

/** Gerçek SDK isteğini yakalayan sahte Messages API. */
async function withFakeApi(respond, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
      const { status = 200, body } = respond();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Anthropic({ apiKey: 'test', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
  try {
    return await run(client, requests);
  } finally {
    server.close();
  }
}

function message(payload, stopReason = 'end_turn') {
  return {
    body: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: stopReason,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: 'thinking', thinking: '', signature: 's' },
        { type: 'text', text: JSON.stringify(payload) },
      ],
    },
  };
}

test('fotoğraf ve durum isteğe eklenir, öneri uygulanmadan döner', async () => {
  const state = emptyState();
  const payload = {
    reply: 'THYAO 40 adet okudum.',
    operations: [{ ...NULL_FIELDS, type: 'set_holding', symbol: 'THYAO', quantity: 40 }],
  };
  await withFakeApi(() => message(payload), async (client, requests) => {
    const result = await askAssistant(
      { text: 'güncelle', images: [{ mediaType: 'image/jpeg', data: 'QUJD' }], history: [{ role: 'assistant', text: 'eski' }, { role: 'user', text: 'merhaba' }, { role: 'assistant', text: 'selam' }] },
      state, TODAY, client,
    );
    assert.deepEqual(result.operations, [{ type: 'set_holding', symbol: 'THYAO', quantity: 40 }]);
    assert.deepEqual(result.descriptions, ['THYAO: 40 adet']);
    assert.equal(result.validationError, null);
    assert.deepEqual(state.holdings, []);

    const { body, headers, url } = requests[0];
    assert.match(url, /\/v1\/messages/);
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.fallbacks, 'default');
    assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.messages[0].role, 'user');
    const last = body.messages.at(-1).content;
    assert.deepEqual(last[0].source, { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' });
    assert.match(last[1].text, /Bugünün tarihi: 2026-11-06/);
  });
});

test('uygulanamayacak öneri validationError ile işaretlenir', async () => {
  const payload = { reply: 'x', operations: [{ ...NULL_FIELDS, type: 'set_bucket', name: 'A', amount: 100 }] };
  await withFakeApi(() => message(payload), async (client) => {
    const result = await askAssistant({ text: 'ayır' }, emptyState(), TODAY, client);
    assert.match(result.validationError, /aşıyor/);
  });
});

test('API hataları ve ret durumları öneri üretmez, anlaşılır mesaj döner', async () => {
  await withFakeApi(() => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'x' } } }), async (client) => {
    const result = await askAssistant({ text: 'a' }, emptyState(), TODAY, client);
    assert.match(result.reply, /API anahtarı geçersiz/);
    assert.deepEqual(result.operations, []);
  });
  await withFakeApi(() => message({ reply: '', operations: [] }, 'refusal'), async (client) => {
    const result = await askAssistant({ text: 'a' }, emptyState(), TODAY, client);
    assert.match(result.reply, /yanıtlamadı/);
  });
});

test('desteklenmeyen fotoğraf biçimi ve fazla fotoğraf reddedilir', async () => {
  await assert.rejects(askAssistant({ images: [{ mediaType: 'image/heic', data: 'x' }] }, emptyState(), TODAY, {}), /Desteklenmeyen/);
  const many = Array.from({ length: 11 }, () => ({ mediaType: 'image/png', data: 'x' }));
  await assert.rejects(askAssistant({ images: many }, emptyState(), TODAY, {}), /En fazla 10/);
});

test('10 fotoğraf kabul edilir', async () => {
  const ten = Array.from({ length: 10 }, () => ({ mediaType: 'image/jpeg', data: 'QUJD' }));
  await withFakeApi(() => message({ reply: 'tamam', operations: [] }), async (client, requests) => {
    const result = await askAssistant({ images: ten }, emptyState(), TODAY, client);
    assert.equal(result.reply, 'tamam');
    assert.equal(requests[0].body.messages.at(-1).content.filter((b) => b.type === 'image').length, 10);
  });
});

test('null alanlar temizlenince set_bucket mevcut kart bağlantısını korur', () => {
  let state = applyOperations(
    emptyState(),
    [
      { type: 'set_card', name: 'Kart A', amount: 100, statementDay: 1, dueDay: 10 },
      { type: 'set_fund', name: 'IOO', amount: 1000, moneyMarket: true },
      { type: 'set_bucket', name: 'Kart', amount: 100, cardName: 'Kart A' },
    ],
    TODAY,
  );
  const op = cleanOperation({ ...NULL_FIELDS, type: 'set_bucket', name: 'Kart', amount: 200 });
  state = applyOperations(state, [op], TODAY);
  assert.equal(state.moneyMarket.buckets[0].cardId, state.cards[0].id);
  assert.equal(state.moneyMarket.buckets[0].amount, 200);
});

test('önizleme cümleleri okunur', () => {
  assert.equal(
    describeOperation({ type: 'set_card', name: 'Kart A', amount: 500, dueDay: 28 }).replace(/ /g, ' '),
    "Kart A: borç ₺500,00, son ödeme ayın 28'i",
  );
});
