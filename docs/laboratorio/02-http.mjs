import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { trovaOccasioni } from './01-filtro.mjs';

// Server di laboratorio: nessuna chiamata a Vinted o Telegram.
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  response.setHeader('Content-Type', 'application/json');
  if (url.pathname !== '/items') {
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'Risorsa assente' }));
    return;
  }
  response.end(JSON.stringify({ items: [
    { id: 1, titolo: 'Bracciale', prezzo: 20 },
    { id: 2, titolo: 'Collana', prezzo: 45 },
  ] }));
});

async function caricaArticoli(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.items)) throw new Error('items deve essere un array');
  return data.items;
}

// Porta 0: il sistema sceglie una porta libera. Bind soltanto su loopback.
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = new URL('/items', base);
  url.search = new URLSearchParams({ search_text: 'bracciale argento', price_to: '25' }).toString();
  const articoli = await caricaArticoli(url);
  const occasioni = trovaOccasioni(articoli, 25);
  assert.deepEqual(occasioni.map(a => a.id), [1]);
  console.log('Richiesta HTTP riuscita:', occasioni);
  await assert.rejects(caricaArticoli(new URL('/missing', base)), /HTTP 404/);
  console.log('Gestione HTTP 404 verificata');
} finally {
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}
