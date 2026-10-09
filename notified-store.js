import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// SQLite è integrato in Node >=22.13: niente server o moduli nativi da compilare.
// Set per i controlli rapidi; SQLite per inserimenti persistenti e transazioni.
export function createNotifiedStore(file, ttlMs, now = Date.now) {
  const databaseFile = /\.json$/i.test(file) ? file.replace(/\.json$/i, '.sqlite') : file;
  const legacyFile = /\.json$/i.test(file) ? file : file.replace(/\.(sqlite|db)$/i, '.json');
  const notified = new Set();
  const pending = new Map();
  let database;
  let insert;
  let loaded = false;
  let nextPruneAt = 0;

  function transaction(action) {
    database.exec('BEGIN IMMEDIATE');
    try {
      action();
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  async function migrateLegacy() {
    if (database.prepare("SELECT value FROM metadata WHERE key = 'json_migrated'").get()) return;
    let data = { version: 1, entries: [] };
    if (legacyFile !== databaseFile) {
      try { data = JSON.parse(await readFile(legacyFile, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Archivio JSON precedente illeggibile o corrotto: conserva il file e controllalo prima di migrare');
      }
    }
    if (!data || data.version !== 1 || !Array.isArray(data.entries)
      || data.entries.some(entry => !Array.isArray(entry) || entry.length !== 2
        || typeof entry[0] !== 'string' || !/^\d{1,30}$/.test(entry[0])
        || !Number.isSafeInteger(entry[1]) || entry[1] < 0)) {
      throw new Error('Formato archivio JSON non valido: nessun dato precedente è stato sovrascritto');
    }
    // Importazione e marcatore nello stesso commit: non reimportiamo ID scaduti.
    transaction(() => {
      for (const [id, time] of data.entries) insert.run(id, time);
      database.prepare("INSERT INTO metadata (key, value) VALUES ('json_migrated', '1')").run();
    });
    // Il JSON originale resta intatto come backup.
  }

  async function load() {
    if (loaded) return;
    try {
      await mkdir(dirname(databaseFile), { recursive: true });
      database = new DatabaseSync(databaseFile);
      database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS notified (
          id TEXT PRIMARY KEY,
          notified_at INTEGER NOT NULL CHECK (notified_at >= 0)
        );
        CREATE INDEX IF NOT EXISTS notified_at_idx ON notified(notified_at);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      insert = database.prepare(`INSERT INTO notified (id, notified_at) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET notified_at = MAX(notified_at, excluded.notified_at)`);
      await migrateLegacy();
      // Prima pulizia all'avvio; poi al massimo una volta all'ora.
      database.prepare('DELETE FROM notified WHERE notified_at <= ?').run(now() - ttlMs);
      for (const row of database.prepare('SELECT id FROM notified').all()) notified.add(row.id);
      nextPruneAt = now() + Math.min(3_600_000, ttlMs);
      loaded = true;
    } catch (error) {
      database?.close();
      database = undefined;
      if (error.message.startsWith('Archivio JSON') || error.message.startsWith('Formato archivio')) throw error;
      throw new Error('Archivio SQLite non disponibile: verifica file, permessi e spazio disco; nessun archivio precedente è stato cancellato');
    }
  }

  function prune() {
    if (!loaded) throw new Error('Archivio notifiche non inizializzato');
    if (now() < nextPruneAt) return;
    try {
      // L'indice sulla data evita di scorrere tutti gli ID in JavaScript.
      const removed = database.prepare('DELETE FROM notified WHERE notified_at <= ? RETURNING id').all(now() - ttlMs);
      for (const row of removed) if (!pending.has(row.id)) notified.delete(row.id);
      nextPruneAt = now() + Math.min(3_600_000, ttlMs);
    } catch {
      throw new Error('Archivio SQLite: pulizia scadenze fallita; il bot riproverà');
    }
  }

  async function flush() {
    if (!loaded) throw new Error('Archivio notifiche non inizializzato');
    if (pending.size === 0) return;
    try {
      transaction(() => { for (const [id, time] of pending) insert.run(id, time); });
      pending.clear();
    } catch {
      throw new Error('Salvataggio archivio SQLite fallito: verifica permessi e spazio disco; il bot riproverà');
    }
  }

  async function add(id) {
    if (!loaded) throw new Error('Archivio notifiche non inizializzato');
    if (!/^\d{1,30}$/.test(id)) throw new Error('ID notifica non valido');
    notified.add(id);
    pending.set(id, now());
    // Se fallisce, l'ID resta in memoria; initialize ritenta prima delle richieste.
    await flush();
  }

  function close() {
    database?.close();
    database = undefined;
    loaded = false;
    notified.clear();
  }

  return { notified, load, prune, flush, add, close, databaseFile };
}
