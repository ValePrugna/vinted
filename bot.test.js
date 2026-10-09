import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMonitor as makeMonitor, readConfig, getPhotoUrl } from './bot.js';
import { createNotifiedStore as makeStore } from './notified-store.js';

const dirs = [];
const closables = [];
const createMonitor = (...args) => { const monitor = makeMonitor(...args); closables.push(monitor); return monitor; };
const createNotifiedStore = (...args) => { const store = makeStore(...args); closables.push(store); return store; };
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'vinted-test-')); dirs.push(dir); return dir; };
after(() => { for (const resource of closables) resource.close(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const config = () => readConfig({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '123', SEARCH_TEXT: 'nike', NOTIFIED_FILE: join(temp(), 'notified.sqlite') });
const rows = file => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('SELECT id, notified_at FROM notified ORDER BY id').all().map(row => [row.id, row.notified_at]); } finally { db.close(); } };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const item = { id: 42, title: 'Scarpe Nike', price: { amount: '20', currency_code: 'EUR' }, size_title: '42', brand_title: 'Nike' };

test('La diagnostica non richiede Telegram e non invia notifiche', async () => {
  const cfg = readConfig({}, false);
  const monitor = createMonitor(cfg, async url => {
    assert.ok(!url.includes('telegram'));
    return url.endsWith('/') ? new Response('homepage') : json({ items: [item] });
  });
  assert.deepEqual(await monitor.inspect(), [{ searchText: '', items: 1, fields: Object.keys(item), priceFields: ['amount', 'currency_code'] }]);
  assert.equal(monitor.notified.size, 0);
});

test('La diagnostica segnala strutture di risposta inattese', async () => {
  const monitor = createMonitor(readConfig({}, false), async url => url.endsWith('/') ? new Response('homepage') : json({ unexpected: [] }));
  await assert.rejects(monitor.inspect(), /items assente/);
});

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
      return new Response('homepage', { headers: { 'Set-Cookie': `session=s${sessions}; Domain=.vinted.it; Path=/; Secure; HttpOnly` } });
    }
    searches++;
    assert.equal(new URL(url).origin, 'https://api.vinted.it');
    assert.equal(new URL(url).pathname, '/svc-catalogue/items');
    assert.match(new URL(url).searchParams.get('global_search_session_id'), /^[0-9a-f-]{36}$/);
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

test('Ricerche multiple: soglie distinte e deduplicazione condivisa', async () => {
  const searches = [];
  const sends = [];
  const cfg = { ...config(), searches: [
    { searchText: 'pandora lotto', priceTo: 25, order: 'newest_first' },
    { searchText: 'pandora completo', priceTo: 40, order: 'newest_first' },
  ] };
  const monitor = createMonitor(cfg, async (url, options) => {
    if (url.includes('telegram')) { sends.push(JSON.parse(options.body)); return json({ ok: true }); }
    if (url.endsWith('/')) return new Response('homepage');
    const params = new URL(url).searchParams;
    searches.push([params.get('search_text'), params.get('price_to')]);
    return json({ items: [item, { ...item, id: 43, price: { amount: '35', currency_code: 'EUR' } }] });
  });
  await monitor.check();
  assert.deepEqual(searches, [['pandora lotto', '25'], ['pandora completo', '40']]);
  assert.equal(sends.length, 2);
  assert.ok(sends[0].text.includes('Ricerca: pandora lotto'));
  assert.ok(sends[1].text.includes('Ricerca: pandora completo'));
});

test('Invia foto e pulsante, con didascalia entro il limite Telegram', async () => {
  const requests = [];
  const photo = 'https://images1.vinted.net/t/photo.jpeg';
  const monitor = createMonitor(config(), async (url, options) => {
    if (url.includes('telegram')) { requests.push({ url, body: JSON.parse(options.body) }); return json({ ok: true }); }
    if (url.endsWith('/')) return new Response('homepage');
    return json({ items: [{ ...item, title: '🎁'.repeat(1000), photo: { url: photo } }] });
  });
  await monitor.check();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/sendPhoto'));
  assert.equal(requests[0].body.photo, photo);
  assert.ok(requests[0].body.caption.length <= 1024);
  assert.equal(requests[0].body.reply_markup.inline_keyboard[0][0].url, 'https://www.vinted.it/items/42');
});

test('Foto rifiutata con 400: fallback testuale e un solo ID registrato', async () => {
  const methods = [];
  const monitor = createMonitor(config(), async url => {
    if (url.includes('telegram')) { methods.push(url.split('/').at(-1)); return url.endsWith('/sendPhoto') ? json({}, 400) : json({ ok: true }); }
    if (url.endsWith('/')) return new Response('homepage');
    return json({ items: [{ ...item, photo: { url: 'https://images1.vinted.net/a.jpg' } }] });
  });
  await monitor.check();
  assert.deepEqual(methods, ['sendPhoto', 'sendMessage']);
  assert.equal(monitor.notified.size, 1);
});

test('Foto con errore 429: nessun fallback immediato e ID non registrato', async () => {
  const methods = [];
  const monitor = createMonitor(config(), async url => {
    if (url.includes('telegram')) { methods.push(url.split('/').at(-1)); return json({}, 429); }
    if (url.endsWith('/')) return new Response('homepage');
    return json({ items: [{ ...item, photo: { url: 'https://images1.vinted.net/a.jpg' } }] });
  });
  await monitor.check();
  assert.deepEqual(methods, ['sendPhoto']);
  assert.equal(monitor.notified.size, 0);
});

test('Foto: fallback alla lista, URL esterni o con credenziali esclusi', () => {
  assert.equal(getPhotoUrl({ photo: { url: 'https://example.com/a' }, photos: [{ url: 'https://images2.vinted.net/b.jpg' }] }), 'https://images2.vinted.net/b.jpg');
  assert.equal(getPhotoUrl({ photo: { url: 'https://user:pass@images1.vinted.net/a' } }), null);
  assert.equal(getPhotoUrl({ photo: { url: 'http://images1.vinted.net/a' } }), null);
  assert.equal(getPhotoUrl({ photo: { url: 'https://images1.vinted.net.evil.example/a' } }), null);
});

test('Riavvio del monitor: gli ID già inviati restano esclusi', async () => {
  const cfg = config();
  let sends = 0;
  const fetchFn = async url => {
    if (url.includes('telegram')) { sends++; return json({ ok: true }); }
    return url.endsWith('/') ? new Response('homepage') : json({ items: [item] });
  };
  const original = createMonitor(cfg, fetchFn);
  await original.check();
  original.close();
  const restarted = createMonitor(cfg, fetchFn);
  await restarted.check();
  assert.equal(sends, 1);
  assert.ok(restarted.notified.has('42'));
  assert.equal(rows(cfg.notifiedFile)[0][0], '42');
});

test('Scadenza archivio: elimina solo gli ID scaduti e scrive un file valido', async () => {
  const dir = temp();
  const file = join(dir, 'notified.sqlite');
  let now = 1000;
  const store = createNotifiedStore(file, 100, () => now);
  await store.load();
  await store.add('1');
  now = 1050;
  await store.add('2');
  now = 1100;
  store.prune();
  await store.flush();
  assert.deepEqual([...store.notified], ['2']);
  assert.deepEqual(rows(file), [['2', 1050]]);
  store.close();
  const restored = createNotifiedStore(file, 100, () => now);
  await restored.load();
  assert.deepEqual([...restored.notified], ['2']);
});

test('Archivio corrotto: arresta inizializzazione senza cancellare dati', async () => {
  const cfg = config();
  await writeFile(cfg.notifiedFile, '{file corrotto');
  await assert.rejects(createMonitor(cfg).initialize(), /SQLite non disponibile/);
  assert.equal(await readFile(cfg.notifiedFile, 'utf8'), '{file corrotto');
});

test('Salvataggio fallito: conserva ID in memoria e ritenta la scrittura', async () => {
  const file = join(temp(), 'notified.sqlite');
  const store = createNotifiedStore(file, 1000, () => 1000);
  await store.load();
  const lock = new DatabaseSync(file);
  lock.exec('BEGIN IMMEDIATE'); // Un altro writer impedisce temporaneamente il commit.
  await assert.rejects(store.add('42'), /Salvataggio archivio/);
  assert.ok(store.notified.has('42'));
  assert.deepEqual(rows(file), []);
  lock.exec('ROLLBACK');
  lock.close();
  await store.flush();
  assert.deepEqual(rows(file), [['42', 1000]]);
});

test('Migrazione JSON: conserva ID e date, mantiene il backup e importa una sola volta', async () => {
  const file = join(temp(), 'notified.json');
  const contents = JSON.stringify({ version: 1, entries: [['42', 1000], ['43', 950], ['42', 990]] });
  await writeFile(file, contents);
  let now = 1050;
  const store = createNotifiedStore(file, 100, () => now);
  await store.load();
  assert.deepEqual([...store.notified], ['42']);
  assert.deepEqual(rows(store.databaseFile), [['42', 1000]]);
  assert.equal(await readFile(file, 'utf8'), contents);
  store.close();
  now = 1150;
  const restarted = createNotifiedStore(file, 100, () => now);
  await restarted.load();
  assert.equal(restarted.notified.size, 0);
  assert.equal(await readFile(file, 'utf8'), contents);
  // Anche un vecchio JSON ora corrotto non viene riletto dopo la migrazione.
  restarted.close();
  await writeFile(file, 'backup modificato');
  await restarted.load();
  assert.equal(restarted.notified.size, 0);
});

test('JSON corrotto: migrazione bloccata, riprende dopo la correzione', async () => {
  const file = join(temp(), 'notified.json');
  await writeFile(file, '{corrotto');
  const store = createNotifiedStore(file, 100, () => 1000);
  await assert.rejects(store.load(), /JSON precedente.*corrotto/);
  assert.equal(await readFile(file, 'utf8'), '{corrotto');
  await writeFile(file, JSON.stringify({ version: 1, entries: [['42', 990]] }));
  await store.load();
  assert.ok(store.notified.has('42'));
});

test('Pulizia periodica: non scorre gli ID ad ogni ciclo', async () => {
  let now = 10_000_000;
  const store = createNotifiedStore(join(temp(), 'notified.sqlite'), 7_200_000, () => now);
  await store.load();
  await store.add('42');
  const db = new DatabaseSync(store.databaseFile);
  // La modifica serve soltanto a osservare quando passa la pulizia SQL.
  db.prepare('UPDATE notified SET notified_at = 0').run();
  now += 1000;
  store.prune();
  assert.ok(store.notified.has('42'));
  now += 3_600_000;
  store.prune();
  assert.equal(store.notified.size, 0);
  assert.deepEqual(rows(store.databaseFile), []);
  db.close();
});

test('Configurazione ricerche: legge JSON e mantiene il vecchio .env', async () => {
  const file = join(temp(), 'searches.json');
  await writeFile(file, JSON.stringify([{ search_text: 'pandora lotto', price_to: 35 }]));
  assert.deepEqual(readConfig({ SEARCHES_FILE: file }, false).searches, [{ searchText: 'pandora lotto', priceTo: 35, order: 'newest_first' }]);
  assert.equal(readConfig({ SEARCH_TEXT: 'nike', PRICE_TO: '20' }, false).searches, null);
  await writeFile(file, JSON.stringify([{ search_text: 'pandora', price_to: -1 }]));
  assert.throws(() => readConfig({ SEARCHES_FILE: file }, false), /Ricerca 1/);
  assert.throws(() => readConfig({ NOTIFIED_TTL_DAYS: '0' }, false), /NOTIFIED_TTL_DAYS/);
});
