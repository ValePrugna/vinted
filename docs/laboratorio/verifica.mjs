import test from 'node:test';
import assert from 'node:assert/strict';
import { trovaOccasioni } from './01-filtro.mjs';
import { creaMonitor } from './03-monitor.mjs';

test('Filtro: include soglia e zero, esclude prezzi non validi', () => {
  const articoli = [0, 25, 25.01, -1, NaN, '20'].map((prezzo, id) => ({ id, prezzo }));
  assert.deepEqual(trovaOccasioni(articoli, 25).map(a => a.id), [0, 1]);
});

test('Due controlli notificano una sola volta e normalizzano ID', async () => {
  const inviati = [];
  let chiamate = 0;
  const monitor = creaMonitor({
    massimo: 25,
    carica: async () => [{ id: ++chiamate === 1 ? 42 : '42', prezzo: 20 }],
    invia: async articolo => { inviati.push(articolo.id); },
  });
  await monitor.controlla();
  await monitor.controlla();
  assert.deepEqual(inviati, [42]);
  assert.deepEqual([...monitor.notificati], ['42']);
});

test('Invio fallito: ID non registrato e controllo successivo possibile', async () => {
  let tentativi = 0;
  const monitor = creaMonitor({
    massimo: 25,
    carica: async () => [{ id: 1, prezzo: 20 }],
    invia: async () => { if (++tentativi === 1) throw new Error('Invio fallito'); },
  });
  await assert.rejects(monitor.controlla(), /Invio fallito/);
  assert.equal(monitor.notificati.size, 0);
  assert.equal((await monitor.controlla()).inviati, 1);
  assert.ok(monitor.notificati.has('1'));
});

test('Acquisizione fallita: il blocco viene liberato', async () => {
  let tentativi = 0;
  const monitor = creaMonitor({
    massimo: 25,
    carica: async () => { if (++tentativi === 1) throw new Error('Rete'); return []; },
    invia: async () => {},
  });
  await assert.rejects(monitor.controlla(), /Rete/);
  assert.equal((await monitor.controlla()).saltato, false);
});

test('Un controllo attivo impedisce sovrapposizioni', async () => {
  let sblocca;
  const attesa = new Promise(resolve => { sblocca = resolve; });
  let richieste = 0;
  const monitor = creaMonitor({
    massimo: 25,
    carica: async () => { richieste++; await attesa; return []; },
    invia: async () => {},
  });
  const primo = monitor.controlla();
  assert.equal((await monitor.controlla()).saltato, true);
  sblocca();
  await primo;
  assert.equal(richieste, 1);
});
