import 'dotenv/config';
import cron from 'node-cron';
import { CookieJar } from 'tough-cookie';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createNotifiedStore } from './notified-store.js';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function readConfig(env = process.env, requireTelegram = true) {
  const number = (name, fallback) => {
    const value = env[name]?.trim() ? Number(env[name]) : fallback;
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name}: numero non negativo richiesto`);
    return value;
  };
  const base = new URL(env.VINTED_BASE_URL || 'https://www.vinted.it');
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('VINTED_BASE_URL deve essere un URL HTTPS senza credenziali');
  // Il catalogo osservato sul sito italiano usa un host API separato.
  const catalog = new URL(env.VINTED_CATALOG_URL || `https://${base.hostname.replace(/^www\./, 'api.')}/svc-catalogue/items`);
  if (catalog.protocol !== 'https:' || catalog.username || catalog.password || catalog.search || catalog.hash) throw new Error('VINTED_CATALOG_URL deve essere un URL HTTPS senza credenziali o parametri');
  if (catalog.hostname.replace(/^(www|api)\./, '') !== base.hostname.replace(/^(www|api)\./, '')) throw new Error('Il catalogo deve appartenere allo stesso dominio Vinted della homepage');
  if (requireTelegram && (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)) throw new Error('Configura TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID in .env');
  const schedule = env.CRON_SCHEDULE || '*/30 * * * * *';
  if (!cron.validate(schedule)) throw new Error('CRON_SCHEDULE non valido');
  const perPage = number('PER_PAGE', 20);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 96) throw new Error('PER_PAGE deve essere un intero tra 1 e 96');
  let searches = null;
  if (env.SEARCHES_FILE?.trim()) {
    try { searches = JSON.parse(readFileSync(resolve(env.SEARCHES_FILE.trim()), 'utf8')); }
    catch { throw new Error('SEARCHES_FILE: file mancante o JSON non valido'); }
    if (!Array.isArray(searches) || searches.length < 1 || searches.length > 20) throw new Error('SEARCHES_FILE deve contenere da 1 a 20 ricerche');
    searches = searches.map((search, index) => {
      if (!search || typeof search.search_text !== 'string' || !search.search_text.trim()
        || typeof search.price_to !== 'number' || !Number.isFinite(search.price_to) || search.price_to < 0
        || (search.order !== undefined && typeof search.order !== 'string')) {
        throw new Error(`Ricerca ${index + 1}: search_text e price_to non validi`);
      }
      return { searchText: search.search_text.trim(), priceTo: search.price_to, order: search.order || env.ORDER || 'newest_first' };
    });
  }
  const ttlDays = number('NOTIFIED_TTL_DAYS', 30);
  if (ttlDays < 1 || ttlDays > 365) throw new Error('NOTIFIED_TTL_DAYS deve essere tra 1 e 365');
  return {
    baseUrl: base.origin, catalogUrl: catalog.href, token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID,
    searchText: env.SEARCH_TEXT || '', priceTo: number('PRICE_TO', 40),
    order: env.ORDER || 'newest_first', perPage, schedule,
    resalePrice: env.ESTIMATED_RESALE_PRICE?.trim() ? number('ESTIMATED_RESALE_PRICE', 0) : null,
    minProfit: number('MIN_PROFIT', 10), costs: number('ESTIMATED_COSTS', 8),
    searches, notifiedFile: resolve(env.NOTIFIED_FILE || '.data/notified.sqlite'), notifiedTtlMs: ttlDays * 86_400_000,
  };
}

function getSearches(config) {
  return config.searches || [{ searchText: config.searchText, priceTo: config.priceTo, order: config.order }];
}

// Telegram recupera la foto direttamente. Non inoltriamo cookie Vinted.
export function getPhotoUrl(item) {
  for (const candidate of [item.photo?.url, ...(Array.isArray(item.photos) ? item.photos.map(photo => photo?.url) : [])]) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port
        && (url.hostname === 'vinted.net' || url.hostname.endsWith('.vinted.net'))) return url.href;
    } catch { /* Nessuna foto valida: useremo un messaggio testuale. */ }
  }
  return null;
}

// Dipendenza fetch iniettabile per verificare il bot senza servizi reali.
export function createMonitor(config, fetchFn = fetch, options = {}) {
  const jar = new CookieJar();
  const store = options.store || createNotifiedStore(config.notifiedFile, config.notifiedTtlMs);
  const notified = store.notified;
  let sessionReady = false;
  let running = false;
  let nextCheckAt = 0;
  let failures = 0;

  async function vintedRequest(url, accept) {
    const cookie = await jar.getCookieString(url);
    const response = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'it-IT,it;q=0.9', Referer: `${config.baseUrl}/`, ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    // CookieJar rispetta dominio, percorso e scadenza dei cookie.
    for (const value of response.headers.getSetCookie()) await jar.setCookie(value, response.url || url);
    return response;
  }

  function httpError(response, service) {
    const error = new Error(`${service}: HTTP ${response.status}`);
    const retry = response.headers.get('retry-after');
    const seconds = retry ? Number(retry) : NaN;
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
    if (response.status === 429) error.retryAfter = Math.max(60_000, Number.isFinite(delay) ? delay : 60_000);
    return error;
  }

  async function refreshSession() {
    sessionReady = false;
    await jar.removeAllCookies();
    const response = await vintedRequest(`${config.baseUrl}/`, 'text/html');
    if (!response.ok) throw httpError(response, 'Sessione Vinted');
    await response.arrayBuffer(); // Consuma la risposta prima delle richieste successive.
    sessionReady = true;
  }

  async function getItems(search) {
    if (!sessionReady) await refreshSession();
    const url = new URL(config.catalogUrl);
    url.search = new URLSearchParams({ search_text: search.searchText, price_to: String(search.priceTo), order: search.order, per_page: String(config.perPage), page: '1', global_search_session_id: randomUUID() }).toString();
    let response = await vintedRequest(url.href, 'application/json');
    if (response.status === 401) {
      await response.arrayBuffer();
      await refreshSession();
      response = await vintedRequest(url.href, 'application/json'); // Un solo tentativo aggiuntivo.
    }
    if (!response.ok) throw httpError(response, 'Ricerca Vinted');
    const data = await response.json();
    if (!Array.isArray(data.items)) throw new Error('Risposta Vinted inattesa: items assente');
    return data.items;
  }

  async function notify(item, amount, currency, search) {
    // URL ricostruito sul dominio configurato, senza fidarsi di link esterni nella risposta.
    const link = new URL(`/items/${item.id}`, config.baseUrl).href;
    const profit = config.resalePrice === null ? '' : `\nMargine stimato: ${(config.resalePrice - amount - config.costs).toFixed(2)} EUR`;
    const message = `Titolo: ${String(item.title || 'N/D').slice(0, 300)}\nPrezzo: ${amount.toFixed(2)} ${String(currency).slice(0, 10)}\nTaglia: ${String(item.size_title || 'N/D').slice(0, 80)}\nMarca: ${String(item.brand_title || 'N/D').slice(0, 80)}\nRicerca: ${search.searchText.slice(0, 100)}${profit}\nLink: ${link}`;
    const replyMarkup = { inline_keyboard: [[{ text: 'Apri su Vinted', url: link }]] };
    async function send(photo) {
      const response = await fetchFn(`https://api.telegram.org/bot${config.token}/${photo ? 'sendPhoto' : 'sendMessage'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: config.chatId, reply_markup: replyMarkup,
          ...(photo ? { photo, caption: message.slice(0, 1000) } : { text: message, link_preview_options: { is_disabled: true } }) }),
        signal: AbortSignal.timeout(20_000),
      });
      // Soltanto un rifiuto certo della foto autorizza il fallback; timeout e 429 no.
      if (photo && response.status === 400) {
        await response.arrayBuffer();
        return false;
      }
      if (!response.ok) throw httpError(response, 'Telegram');
      const data = await response.json();
      if (data.ok !== true) throw new Error('Telegram: invio non confermato');
      return true;
    }
    const photo = getPhotoUrl(item);
    if (!await send(photo)) await send(null);
  }

  async function initialize() {
    await store.load();
    store.prune();
    await store.flush();
  }

  async function check() {
    // Evita sovrapposizioni se rete o notifiche richiedono più dell'intervallo cron.
    if (running || Date.now() < nextCheckAt) return;
    running = true;
    try {
      await initialize();
      let sent = 0;
      // Richieste sequenziali: evitiamo un picco simultaneo per tutte le ricerche.
      for (const search of getSearches(config)) {
        const items = await getItems(search);
        for (const item of items) {
          const id = String(item.id ?? '');
          if (!/^\d{1,30}$/.test(id) || notified.has(id)) continue;
          const raw = typeof item.price === 'object' ? item.price?.amount : item.price;
          const amount = (typeof raw !== 'number' && typeof raw !== 'string') || (typeof raw === 'string' && !raw.trim()) ? NaN : Number(raw);
          const currency = item.price?.currency_code || item.currency || 'EUR';
          if (!Number.isFinite(amount) || amount < 0 || amount > search.priceTo) continue;
          if (config.resalePrice !== null && (currency !== 'EUR' || config.resalePrice - amount - config.costs < config.minProfit)) continue;
          await notify(item, amount, currency, search);
          await store.add(id); // Salvataggio dopo l'invio confermato, anche tra riavvii.
          sent++;
          console.log(`Articolo ${id}: notifica inviata`);
        }
      }
      failures = 0;
      console.log(`Controllo completato: ${getSearches(config).length} ricerche, ${sent} nuove notifiche`);
    } catch (error) {
      failures += 1;
      const delay = Math.max(error.retryAfter || 0, Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures, 6)));
      nextCheckAt = Date.now() + delay;
      // Non stampare URL Telegram o errori fetch che potrebbero contenere il token.
      const reason = error.message.includes('HTTP ') || error.message.startsWith('Archivio') || error.message.startsWith('Formato archivio') || error.message.startsWith('Salvataggio archivio') ? error.message : 'errore di rete o risposta inattesa';
      console.error(`Controllo fallito (${reason}). Nuovo tentativo tra ${Math.ceil(delay / 1000)} secondi.`);
    } finally {
      running = false;
    }
  }
  // Diagnostica senza Telegram: espone solo conteggi e nomi dei campi.
  async function inspect() {
    const results = [];
    for (const search of getSearches(config)) {
      const items = await getItems(search);
      const first = items[0];
      results.push({
        searchText: search.searchText,
        items: items.length,
        fields: first ? Object.keys(first) : [],
        priceFields: first && typeof first.price === 'object' && first.price !== null ? Object.keys(first.price) : [],
      });
    }
    return results;
  }
  return { check, notified, inspect, initialize, close: () => store.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const diagnostic = process.argv.includes('--check');
    const config = readConfig(process.env, !diagnostic);
    const monitor = createMonitor(config);
    if (diagnostic) {
      for (const result of await monitor.inspect()) {
        console.log(`Ricerca: ${result.searchText || '(tutto il catalogo)'}`);
        console.log(`Catalogo raggiunto. Articoli restituiti: ${result.items}`);
        console.log(`Campi articolo: ${result.fields.join(', ') || '(nessun articolo)'}`);
        console.log(`Campi prezzo: ${result.priceFields.join(', ') || '(prezzo semplice o assente)'}`);
      }
    } else {
      await monitor.initialize();
      const task = cron.schedule(config.schedule, monitor.check);
      console.log(`Monitoraggio avviato: ${getSearches(config).map(search => `${search.searchText || '(tutto il catalogo)'} (max ${search.priceTo})`).join('; ')}`);
      void monitor.check();
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { task.stop(); monitor.close(); process.exit(0); });
    }
  } catch (error) {
    // Errori fetch possono includere URL: non stampare dettagli di rete sensibili.
    console.error(error instanceof TypeError ? 'Richiesta fallita: verifica connessione e accesso ai domini Vinted.' : error.message);
    process.exitCode = 1;
  }
}
