import { trovaOccasioni } from './01-filtro.mjs';

export function creaMonitor({ carica, invia, massimo }) {
  if (typeof carica !== 'function' || typeof invia !== 'function') {
    throw new TypeError('carica e invia devono essere funzioni');
  }
  if (!Number.isFinite(massimo) || massimo < 0) throw new TypeError('Soglia non valida');
  const notificati = new Set();
  let attivo = false;

  async function controlla() {
    if (attivo) return { saltato: true, inviati: 0 };
    attivo = true;
    let conteggio = 0;
    try {
      const articoli = await carica();
      if (!Array.isArray(articoli)) throw new TypeError('Lista articoli non valida');
      for (const articolo of trovaOccasioni(articoli, massimo)) {
        if (articolo.id === null || articolo.id === undefined) continue;
        const id = String(articolo.id);
        if (!/^\d+$/.test(id) || notificati.has(id)) continue;
        await invia(articolo);
        notificati.add(id);
        conteggio++;
      }
      return { saltato: false, inviati: conteggio };
    } finally {
      attivo = false;
    }
  }
  return { controlla, notificati };
}
