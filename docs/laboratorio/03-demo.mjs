import assert from 'node:assert/strict';
import { creaMonitor } from './03-monitor.mjs';

const monitor = creaMonitor({
  massimo: 25,
  carica: async () => [
    { id: 1, titolo: 'Bracciale', prezzo: 20 },
    { id: 2, titolo: 'Collana', prezzo: 45 },
  ],
  invia: async articolo => console.log(`NOTIFICA SIMULATA: ${articolo.titolo}`),
});
const primo = await monitor.controlla();
const secondo = await monitor.controlla();
assert.equal(primo.inviati, 1);
assert.equal(secondo.inviati, 0);
console.log('Primo controllo:', primo);
console.log('Secondo controllo:', secondo);
