# Costruire un bot Vinted con Node.js

Guida pratica per principianti • Versione del 8 ottobre 2026

## 1. Da un'idea a cinque compiti piccoli

La richiesta iniziale sembrava grande: cercare occasioni e inviare messaggi. L'ho divisa in cinque operazioni: leggere la configurazione, aprire una sessione, cercare articoli, eliminare i duplicati e notificare su Telegram. Ogni operazione diventa una funzione verificabile. Non c'è un algoritmo che scopre automaticamente il valore di mercato: il bot applica i criteri che scegli tu.

Il flusso è: avvio → configurazione → homepage e cookie → catalogo → filtro prezzo e margine → controllo ID → Telegram → registrazione ID → attesa del prossimo controllo.

La rapidità viene dall'uso di componenti già esistenti e dalla generazione assistita del codice. La parte che richiede prove è il collegamento ai servizi reali. Nel nostro caso il primo endpoint restituiva 404: una soluzione plausibile e testata con simulazioni non era ancora verificata su Vinted.

Obiettivo di questa guida: capire il programma pubblicato, ricostruirne i pezzi e saper diagnosticare un problema. I frammenti mostrati spiegano il codice; per eseguirlo usa il bot.js completo del repository, riprodotto anche nell'appendice PDF.

## 2. Preparare il progetto su Windows

Installa Node.js LTS 22 o successivo da https://nodejs.org, con Add to PATH selezionato. Chiudi e riapri il terminale. Node esegue JavaScript sul computer; npm installa le librerie.

Nel Prompt dei comandi, verifica e apri la cartella estratta:

```bat
node --version
npm --version
cd /d C:\Users\valep\Desktop\vinted-main
npm ci
```

Per costruire un progetto nuovo, invece, crea una cartella, esegui npm init -y e npm install dotenv node-cron tough-cookie. Imposta "type": "module" in package.json per usare import. Nel progetto già scaricato questi passi sono già stati fatti: non ripeterli.

dotenv legge .env; node-cron pianifica controlli; tough-cookie gestisce cookie e scadenze. fetch è incluso in Node moderno, quindi non serve axios. package-lock.json registra le versioni risolte; npm ci le reinstalla senza riscrivere il lockfile. node_modules contiene le dipendenze e non va caricato su GitHub.

## 3. Configurazione e segreti

Se non hai ancora .env, copialo dal modello. Se esiste e contiene i tuoi dati, non sovrascriverlo.

```bat
copy .env.example .env
notepad .env
```

Esempio di configurazione (le credenziali sono segnaposto):

```dotenv
TELEGRAM_BOT_TOKEN=INSERISCI_IL_TUO_TOKEN
TELEGRAM_CHAT_ID=INSERISCI_IL_TUO_CHAT_ID
VINTED_BASE_URL=https://www.vinted.it
VINTED_CATALOG_URL=https://api.vinted.it/svc-catalogue/items
SEARCH_TEXT=bracciale pandora argento
PRICE_TO=25
ORDER=newest_first
PER_PAGE=20
CRON_SCHEDULE=*/30 * * * * *
ESTIMATED_RESALE_PRICE=
MIN_PROFIT=10
ESTIMATED_COSTS=8
```

import 'dotenv/config' carica il file all'avvio. process.env.SEARCH_TEXT legge una variabile. readConfig converte numeri, controlla gli URL e rifiuta una configurazione incompleta. Ogni modifica richiede il riavvio del bot.

.gitignore esclude .env, node_modules e i log. .env.example contiene solo nomi e valori pubblici. Se un token viene pubblicato per errore, revocalo con BotFather: cancellarlo dall'ultimo file non lo rimuove dalla cronologia Git.

## 4. Trovare l'endpoint e creare una sessione

Un'API è un indirizzo che restituisce dati strutturati. La ricerca visibile sul sito effettua richieste che puoi osservare: apri Vinted, premi Ctrl+Maiusc+I, seleziona Network/Rete e Fetch/XHR, poi fai una ricerca. Cerca items e leggi Request URL e Status Code. Non condividere cookie, token, intestazioni complete o Copy as cURL.

Il vecchio /api/v2/catalog/items restituiva 404. La richiesta che hai osservato il 8 ottobre 2026 era https://api.vinted.it/svc-catalogue/items e rispondeva 200. Questo è un endpoint osservato sul sito, non un contratto pubblico garantito per sempre.

Il bot visita prima https://www.vinted.it/. Riceve i Set-Cookie, li salva nel CookieJar e allega alle richieste successive soltanto i cookie consentiti per quel dominio e percorso. Cookie del solo www non vengono automaticamente inviati ad api; un cookie Domain=.vinted.it può valere per entrambi. Non allarghiamo artificialmente il loro dominio.

```javascript
const cookie = await jar.getCookieString(url);
// Dopo la risposta HTTP:
for (const value of response.headers.getSetCookie()) {
  await jar.setCookie(value, response.url || url);
}
```

Un User-Agent desktop descrive il client; non autentica l'utente e non garantisce accesso. Il bot non risolve CAPTCHA. Un 200 nel browser non garantisce un 200 da Node: il browser può avere una sessione diversa.

## 5. Costruire la ricerca e filtrare gli articoli

URLSearchParams codifica spazi e caratteri speciali: evita di concatenare manualmente parole chiave nell'URL. Il programma costruisce i parametri search_text, price_to, order, per_page, page e un nuovo global_search_session_id tramite randomUUID.

```javascript
const url = new URL(config.catalogUrl);
const params = new URLSearchParams({
  search_text: config.searchText,
  price_to: String(config.priceTo),
  order: config.order,
  page: '1'
});
url.search = params.toString();
```

await fetch attende una risposta senza bloccare tutto il motore JavaScript. await response.json converte il JSON in oggetti. Prima di leggere gli articoli, getItems verifica che data.items sia un array: non considera valida una risposta con una forma sconosciuta.

Nel tuo controllo reale sono arrivati 20 articoli; price contiene amount e currency_code. Il bot converte amount in numero e applica anche localmente PRICE_TO, senza affidarsi solo al filtro remoto. Legge la prima pagina: annunci molto numerosi possono sfuggire tra due controlli.

La risposta osservata non include size_title e brand_title: il codice mostra N/D per quei campi. Non abbiamo ancora adattato taglia e marca al nuovo formato. Aggiungere campi richiede osservarne la struttura, non indovinarla.

## 6. Collegare Telegram

Su Telegram apri @BotFather ufficiale, invia /newbot e scegli nome e username. Copia il token in .env. Apri il tuo bot, premi Avvia e inviagli un messaggio. In locale visita https://api.telegram.org/bot<TOKEN>/getUpdates sostituendo <TOKEN>; cerca l'id dentro chat, non message_id né l'id del bot. L'URL contiene il token: non condividerlo. Se result è vuoto, invia un nuovo messaggio e riprova. Un webhook già configurato rende getUpdates indisponibile.

L'invio è una richiesta POST con corpo JSON:

```javascript
const endpoint = `https://api.telegram.org/bot${config.token}/sendMessage`;
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: config.chatId,
    text: 'Titolo, prezzo e link dell\'articolo'
  })
});
```

Il codice completo usa un timeout, controlla lo stato HTTP e richiede ok:true nella risposta Telegram. Il messaggio è testo semplice: niente interpretazione HTML di titoli degli annunci. Il link viene costruito dall'ID sul dominio Vinted configurato.

## 7. Duplicati e controlli periodici

Un Set contiene valori unici. notified.has(id) verifica se l'articolo è già stato segnalato. notified.add(id) avviene soltanto dopo l'invio confermato: se Telegram fallisce, l'articolo non viene segnato come consegnato.

```javascript
if (notified.has(id)) continue;
await notify(item, amount, currency);
notified.add(id);
```

Il Set è in memoria, si azzera al riavvio e cresce nel tempo. Non garantisce consegna esattamente una volta: Telegram potrebbe accettare un messaggio e la risposta potrebbe andare persa, causando un duplicato al nuovo tentativo. Al primo avvio il bot segnala anche gli annunci già presenti e compatibili.

node-cron usa sei campi: secondi, minuti, ore, giorno del mese, mese, giorno della settimana. */30 * * * * * controlla ai secondi 0 e 30; */10 * * * * * ogni 10 secondi; 0 * * * * * ogni minuto. Una frequenza maggiore non garantisce più profitto e può portare a limiti 429.

running evita due controlli contemporanei. nextCheckAt sospende le nuove richieste durante un'attesa dopo errore. Il primo controllo parte subito, poi cron richiama check. Lo schermo può spegnersi; sospensione, ibernazione o spegnimento fermano l'esecuzione. Un processo locale non diventa automaticamente un servizio sempre acceso.

## 8. Gestire errori e provare il programma

401: il bot elimina i vecchi cookie, visita di nuovo la homepage e ritenta la ricerca una volta. 403: accesso negato; non è un invito ad aggirare una verifica. 404: indirizzo non disponibile o risposta di accesso; si indaga prima di cambiare l'URL. 429: troppe richieste; il bot considera Retry-After e applica un'attesa minima di 60 secondi.

Gli errori consecutivi producono attese progressive. Con l'implementazione attuale la sequenza base è 60, 120, 240, 480, 960, 1800 secondi e poi resta a 1800; Retry-After può imporre un'attesa più lunga. Dopo un controllo riuscito il contatore si azzera. Ogni richiesta ha un timeout di 20 secondi.

Esegui nell'ordine:

```bat
npm test
node bot.js --check
npm start
```

I sei test simulati coprono diagnostica senza Telegram, risposta inattesa, rinnovo 401 e deduplicazione, filtri, errore Telegram 429 e assenza di sovrapposizioni. In createMonitor(config, fetchFn) sostituiamo fetch con risposte controllate: i test non inviano messaggi reali.

--check verifica l'accesso reale al catalogo e mostra conteggi e nomi di campi, senza inviare notifiche. Nel tuo PC ha restituito 20 articoli. npm start verifica il flusso completo; hai poi confermato il funzionamento. I test simulati non dimostrano da soli accesso a Vinted, consegna Telegram o esattezza di una stima economica.

## 9. Calcolare il margine e migliorare il bot

Margine stimato = prezzo realistico di rivendita - prezzo articolo - costi stimati. Esempio puramente didattico: 45 - 25 - 8 = 12 euro. Con ESTIMATED_RESALE_PRICE=45, ESTIMATED_COSTS=8 e MIN_PROFIT=12, un articolo da 25 euro passa il filtro. La soglia di rivendita vale per tutta la ricerca e il filtro accetta soltanto EUR: non è adatta a lotti molto diversi tra loro.

Se lasci ESTIMATED_RESALE_PRICE vuoto, il filtro sul margine è disattivato: il bot controlla solo il prezzo massimo. Stime, autenticità, condizioni e domanda restano responsabilità della valutazione umana. Il programma non compra articoli.

Prossimi miglioramenti sensati: salvare gli ID in un archivio locale con scadenza; supportare più ricerche; leggere marca e taglia dal nuovo formato; mostrare un riepilogo dei controlli; aggiungere test per Retry-After e errori di rete. Sono idee, non funzioni già implementate. Prima di ogni modifica scegli quale comportamento verificare.

## 10. Il metodo da riutilizzare

1. Scrivi input e risultato atteso: ricerca, soglia prezzo, messaggio.
2. Dividi in funzioni piccole con una responsabilità ciascuna.
3. Usa librerie mantenute per compiti comuni, senza ricostruire cookie e cron.
4. Verifica il servizio reale con una richiesta non distruttiva.
5. Scrivi test per errori e comportamenti importanti, non solo per il caso felice.
6. Tieni separati configurazione pubblica e credenziali.
7. Pubblica soltanto i file necessari e documenta cosa è ancora incerto.

L'errore iniziale ci insegna una cosa concreta: l'endpoint e il formato dei dati devono essere confermati prima di chiamare il sistema pronto. Il browser ha fornito un indizio; la diagnostica sul tuo PC ha verificato l'accesso del bot.

Documentazione: https://nodejs.org/en/learn • https://nodecron.com • https://core.telegram.org/bots/api • https://github.com/motdotla/dotenv • https://github.com/salesforce/tough-cookie

Repository e codice completo: https://github.com/ValePrugna/vinted
