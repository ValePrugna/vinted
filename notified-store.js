import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Archivio condiviso tra ricerche: contiene solo ID e data dell'invio.
// Si usa una sola istanza del bot per archivio, non più processi concorrenti.
export function createNotifiedStore(file, ttlMs, now = Date.now) {
  const notified = new Set();
  const timestamps = new Map();
  let loaded = false;
  let dirty = false;

  function prune() {
    for (const [id, time] of timestamps) {
      if (now() - time >= ttlMs) {
        timestamps.delete(id);
        notified.delete(id);
        dirty = true;
      }
    }
  }

  async function load() {
    if (loaded) return;
    let data;
    try {
      data = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Archivio notifiche illeggibile o corrotto: conserva il file e controllalo prima di ripartire');
      data = { version: 1, entries: [] };
      dirty = true;
    }
    if (data.version !== 1 || !Array.isArray(data.entries)
      || data.entries.some(entry => !Array.isArray(entry) || entry.length !== 2
        || typeof entry[0] !== 'string' || !/^\d{1,30}$/.test(entry[0])
        || !Number.isFinite(entry[1]) || entry[1] < 0 || entry[1] > now())) {
      throw new Error('Formato archivio notifiche non valido: nessun dato è stato sovrascritto');
    }
    for (const [id, time] of data.entries) {
      timestamps.set(id, Math.max(time, timestamps.get(id) || 0));
      notified.add(id);
    }
    loaded = true;
    prune();
  }

  async function flush() {
    if (!loaded) throw new Error('Archivio notifiche non inizializzato');
    if (!dirty) return;
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temp, JSON.stringify({ version: 1, entries: [...timestamps] }), { flag: 'wx', mode: 0o600 });
      await rename(temp, file); // Sostituzione atomica: niente file parziali.
      dirty = false;
    } catch {
      throw new Error('Salvataggio archivio notifiche fallito: verifica permessi e spazio disco; il bot riproverà');
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  async function add(id) {
    notified.add(id);
    timestamps.set(id, now());
    dirty = true;
    // In caso di errore resta in memoria: il controllo successivo ritenta flush.
    await flush();
  }

  return { notified, load, prune, flush, add };
}
