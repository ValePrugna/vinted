import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor, readConfig } from './bot.js';

const config = () => readConfig({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '123', SEARCH_TEXT: 'nike' });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const item = { id: 42, title: 'Scarpe Nike', price: { amount: '20', currency_code: 'EUR' }, size_title: '42', brand_title: 'Nike' };

test('Rinnova la sessione dopo 401 e notifica una sola volta con tutti i campi', async () => {
  let sessions = 0;
  let searches = 0;
  const messages = [];
  const monitor = createMonitor(config(), async (url, options) => {
    if (url.includes('api.telegram.org')) {
      messages.push(JSON.parse(options.body));
      return json({ ok: true });
    }
    if (url.endsWith('/')) {
      sessions++;
      return new Response('homepage', { headers: { 'Set-Cookie': `session=s${sessions}; Path=/; Secure; HttpOnly` } });
    }
    searches++;
    assert.equal(new URL(url).searchParams.get('order'), 'newest_first');
    assert.equal(new URL(url).searchParams.get('search_text'), 'nike');
    assert.equal(options.headers.Cookie, `session=s${sessions}`);
    return searches === 1 ? json({}, 401) : json({ items: [item] });
  });
  await monitor.check();
  await monitor.check();
  assert.equal(sessions, 2);
  assert.equal(messages.length, 1);
  for (const value of ['Scarpe Nike', '20.00 EUR', 'Taglia: 42', 'Marca: Nike', 'https://www.vinted.it/items/42']) assert.ok(messages[0].text.includes(value));
  assert.ok(monitor.notified.has('42'));
});

test('Filtra prezzo massimo e margine stimato', async () => {
  const cfg = { ...config(), resalePrice: 40, costs: 8, minProfit: 10 };
  const messages = [];
  const monitor = createMonitor(cfg, async (url, options) => {
    if (url.includes('api.telegram.org')) { messages.push(JSON.parse(options.body)); return json({ ok: true }); }
    if (url.endsWith('/')) return new Response('homepage');
    return json({ items: [item, { ...item, id: 43, price: { amount: '30', currency_code: 'EUR' } }, { ...item, id: 44, price: { amount: '50', currency_code: 'EUR' } }] });
  });
  await monitor.check();
  assert.equal(messages.length, 1);
  assert.ok(messages[0].text.includes('Margine stimato: 12.00 EUR'));
});

test('Un invio Telegram fallito non registra ID e attiva attesa', async () => {
  let sends = 0;
  const monitor = createMonitor(config(), async url => {
    if (url.includes('api.telegram.org')) { sends++; return json({}, 429); }
    if (url.endsWith('/')) return new Response('homepage');
    return json({ items: [item] });
  });
  await monitor.check();
  await monitor.check();
  assert.equal(sends, 1);
  assert.equal(monitor.notified.size, 0);
});

test('Non sovrappone i controlli', async () => {
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const monitor = createMonitor(config(), async url => {
    calls++;
    if (url.endsWith('/')) { await gate; return new Response('homepage'); }
    return json({ items: [] });
  });
  const first = monitor.check();
  await monitor.check();
  release();
  await first;
  assert.equal(calls, 2);
});
