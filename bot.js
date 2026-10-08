import 'dotenv/config';
import cron from 'node-cron';
import { CookieJar } from 'tough-cookie';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

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
  return {
    baseUrl: base.origin, catalogUrl: catalog.href, token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID,
    searchText: env.SEARCH_TEXT || '', priceTo: number('PRICE_TO', 40),
    order: env.ORDER || 'newest_first', perPage, schedule,
    resalePrice: env.ESTIMATED_RESALE_PRICE?.trim() ? number('ESTIMATED_RESALE_PRICE', 0) : null,
    minProfit: number('MIN_PROFIT', 10), costs: number('ESTIMATED_COSTS', 8),
  };
}

// Dipendenza fetch iniettabile per verificare il bot senza servizi reali.
export function createMonitor(config, fetchFn = fetch) {
  const jar = new CookieJar();
  const notified = new Set(); // Si azzera al riavvio; non contiene dati sensibili.
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

  async function getItems() {
    if (!sessionReady) await refreshSession();
    const url = new URL(config.catalogUrl);
    url.search = new URLSearchParams({ search_text: config.searchText, price_to: String(config.priceTo), order: config.order, per_page: String(config.perPage), page: '1', global_search_session_id: randomUUID() }).toString();
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

  async function notify(item, amount, currency) {
    // URL ricostruito sul dominio configurato, senza fidarsi di link esterni nella risposta.
    const link = new URL(`/items/${item.id}`, config.baseUrl).href;
    const profit = config.resalePrice === null ? '' : `\nMargine stimato: ${(config.resalePrice - amount - config.costs).toFixed(2)} EUR`;
    const message = `Titolo: ${String(item.title || 'N/D').slice(0, 600)}\nPrezzo: ${amount.toFixed(2)} ${currency}\nTaglia: ${String(item.size_title || 'N/D').slice(0, 100)}\nMarca: ${String(item.brand_title || 'N/D').slice(0, 100)}${profit}\nLink: ${link}`;
    const response = await fetchFn(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text: message, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw httpError(response, 'Telegram');
    const data = await response.json();
    if (data.ok !== true) throw new Error('Telegram: invio non confermato');
  }

  async function check() {
    // Evita sovrapposizioni se rete o notifiche richiedono più dell'intervallo cron.
    if (running || Date.now() < nextCheckAt) return;
    running = true;
    try {
      const items = await getItems();
      for (const item of items) {
        const id = String(item.id ?? '');
        if (!/^\d+$/.test(id) || notified.has(id)) continue;
        const raw = typeof item.price === 'object' ? item.price?.amount : item.price;
        const amount = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
        const currency = item.price?.currency_code || item.currency || 'EUR';
        if (!Number.isFinite(amount) || amount < 0 || amount > config.priceTo) continue;
        if (config.resalePrice !== null && (currency !== 'EUR' || config.resalePrice - amount - config.costs < config.minProfit)) continue;
        await notify(item, amount, currency);
        notified.add(id); // Registra soltanto invii confermati: un errore sarà ritentato.
        console.log(`Articolo ${id}: notifica inviata`);
      }
      failures = 0;
    } catch (error) {
      failures += 1;
      const delay = Math.max(error.retryAfter || 0, Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures, 6)));
      nextCheckAt = Date.now() + delay;
      // Non stampare URL Telegram o errori fetch che potrebbero contenere il token.
      console.error(`Controllo fallito (${error.message.includes('HTTP ') ? error.message : 'errore di rete o risposta inattesa'}). Nuovo tentativo tra ${Math.ceil(delay / 1000)} secondi.`);
    } finally {
      running = false;
    }
  }
  // Diagnostica senza Telegram: espone solo conteggi e nomi dei campi.
  async function inspect() {
    const items = await getItems();
    const first = items[0];
    return {
      items: items.length,
      fields: first ? Object.keys(first) : [],
      priceFields: first && typeof first.price === 'object' && first.price !== null ? Object.keys(first.price) : [],
    };
  }
  return { check, notified, inspect };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const diagnostic = process.argv.includes('--check');
    const config = readConfig(process.env, !diagnostic);
    const monitor = createMonitor(config);
    if (diagnostic) {
      const result = await monitor.inspect();
      console.log(`Catalogo raggiunto. Articoli restituiti: ${result.items}`);
      console.log(`Campi articolo: ${result.fields.join(', ') || '(nessun articolo)'}`);
      console.log(`Campi prezzo: ${result.priceFields.join(', ') || '(prezzo semplice o assente)'}`);
    } else {
      const task = cron.schedule(config.schedule, monitor.check);
      console.log(`Monitoraggio avviato: ${config.searchText}, prezzo massimo ${config.priceTo}`);
      void monitor.check();
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { task.stop(); process.exit(0); });
    }
  } catch (error) {
    // Errori fetch possono includere URL: non stampare dettagli di rete sensibili.
    console.error(error instanceof TypeError ? 'Richiesta fallita: verifica connessione e accesso ai domini Vinted.' : error.message);
    process.exitCode = 1;
  }
}
