import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Funzione pura: non legge rete o stato globale e non modifica lista.
export function trovaOccasioni(lista, massimo) {
  return lista.filter(articolo => Number.isFinite(articolo.prezzo)
    && articolo.prezzo >= 0 && articolo.prezzo <= massimo);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const articoli = [
    { id: 1, titolo: 'Bracciale', prezzo: 20 },
    { id: 2, titolo: 'Collana', prezzo: 45 },
    { id: 3, titolo: 'Anello', prezzo: 25 },
  ];
  const risultato = trovaOccasioni(articoli, 25);
  assert.deepEqual(risultato.map(a => a.id), [1, 3]);
  console.log(risultato);
}
