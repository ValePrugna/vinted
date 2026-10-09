# Monitor Vinted con notifiche Telegram

Laboratorio di programmazione per studenti ITS: [PDF in italiano](docs/tutorial-vinted.pdf) oppure [versione testuale](docs/tutorial.md). Costruisce il monitor progressivamente con JavaScript, HTTP, async/await, stato e test. Include [esempi eseguibili](docs/laboratorio), 13 esercizi e soluzioni.

Bot Node.js con commenti in italiano: monitora una o più ricerche, rinnova la sessione dopo HTTP 401 e invia notifiche Telegram con foto e pulsante. Gli ID notificati sono conservati su disco e condivisi tra le ricerche. Il laboratorio PDF spiega la versione didattica iniziale; le funzioni aggiunte sono documentate qui.

## Installazione e configurazione

1. Installa Node.js 22 o successivo.
2. Apri la directory del progetto ed esegui `npm ci` per installare le dipendenze dal lockfile.
3. Su Telegram crea un bot con **@BotFather** usando `/newbot` e conserva il token.
4. Apri una conversazione con il tuo bot e invia `/start`. Recupera il tuo `chat.id` con il metodo Telegram `getUpdates` usando il token in locale. Non condividere token, risposte integrali o URL contenenti il token. Se il bot usa già un webhook, `getUpdates` non è disponibile: utilizza l'integrazione esistente per ottenere il chat ID.
5. Se non hai ancora `.env`, esegui `cp .env.example .env` su macOS/Linux o `copy .env.example .env` nel Prompt dei comandi Windows. Inserisci `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`. Se `.env` esiste, mantienilo: non sovrascriverlo.
6. Personalizza `SEARCH_TEXT`, `PRICE_TO` e `ORDER` (predefinito `newest_first`). `CRON_SCHEDULE=*/30 * * * * *` esegue il controllo ogni 30 secondi; per un controllo al minuto usa `0 * * * * *`.
7. Avvia con `npm start`. Il primo controllo è immediato. Arresta con Ctrl+C. Su un server il processo deve rimanere in esecuzione tramite un gestore di processi.
8. Esegui `npm test` per i test con servizi simulati: non richiedono credenziali e non inviano messaggi reali.

## Più ricerche per i lotti Pandora

Il vecchio `.env` continua a funzionare con una singola ricerca. Per attivarne più di una, nel Prompt dei comandi Windows:

```bat
copy searches.example.json searches.json
notepad searches.json
```

Il file è un array JSON; ogni ricerca richiede testo e prezzo massimo, mentre `order` è facoltativo:

```json
[
  { "search_text": "bracciale pandora completo", "price_to": 40 },
  { "search_text": "pandora lotto", "price_to": 40 },
  { "search_text": "pandora charm", "price_to": 25 }
]
```

Aggiungi al tuo `.env`:

```dotenv
SEARCHES_FILE=searches.json
```

Quando il file è configurato, `SEARCH_TEXT` e `PRICE_TO` vengono sostituiti dalle ricerche nel JSON. `ORDER`, `PER_PAGE` e il filtro facoltativo sul margine restano comuni. Sono supportate da 1 a 20 ricerche; vengono eseguite in sequenza, con cookie e deduplicazione condivisi. Più ricerche comportano più richieste: parti da 30–60 secondi e controlla eventuali 429. Una ricerca non valida blocca l'avvio prima di inviare messaggi. Un errore durante un ciclo attiva il backoff e le ricerche rimanenti verranno ritentate nel ciclo successivo.

Per i lotti con contenuti diversi, lascia `ESTIMATED_RESALE_PRICE` vuoto: il bot non conosce il valore dei singoli charm. I prezzi indicati sono filtri sull'articolo, non valutazioni economiche, e non includono automaticamente spedizione o protezione acquisti.

## Foto e registro delle notifiche

Quando `photo.url` o una foto nella lista `photos` contiene un URL HTTPS sul dominio immagini `vinted.net`, Telegram riceve la foto, la didascalia e il pulsante **Apri su Vinted**. Senza foto utilizzabile arriva il messaggio testuale. Se Telegram rifiuta la foto con HTTP 400, il bot ritenta come testo; non esegue questo fallback su timeout o 429. I campi marca e taglia restano `N/D` se la risposta del catalogo non li espone nel formato noto.

Gli ID e le date di invio sono salvati nel file `.data/notified.json`, ignorato da Git. Le impostazioni facoltative sono:

```dotenv
NOTIFIED_FILE=.data/notified.json
NOTIFIED_TTL_DAYS=30
```

Le date scadono dopo 30 giorni dall'invio, non dall'ultima visualizzazione. Dopo la scadenza un articolo ancora visibile può essere notificato di nuovo. La scrittura usa un file temporaneo e sostituzione atomica; non memorizza credenziali, cookie o foto. Se l'archivio è corrotto il bot si ferma all'avvio senza sovrascriverlo: conserva una copia e controllalo. Non eliminare il registro durante l'esecuzione. Usa una sola istanza del bot per archivio.

## Aggiornare dalla versione precedente su Windows

1. Ferma il bot con Ctrl+C.
2. Scarica il nuovo ZIP da GitHub ed estrailo in una cartella diversa.
3. Dalla nuova cartella copia `bot.js`, `notified-store.js`, `searches.example.json` e `README.md` nella tua cartella attuale. Non sostituire `.env`; conserva anche `.data` e `searches.json`, se presenti. Le dipendenze non sono cambiate.
4. Per più ricerche, crea `searches.json` e configura `SEARCHES_FILE` come sopra. Non ricopiare il modello su un file di ricerche già personalizzato.
5. Esegui `node bot.js --check` per verificare tutte le ricerche senza Telegram, poi `npm start`.

Al primo avvio di questa versione manca lo storico della versione precedente, che era solo in memoria: alcuni annunci saranno notificati di nuovo. Da questo momento il registro persiste. Se aggiorni sostituendo tutta la cartella, trasferisci `.env`, `searches.json` e `.data` e reinstalla con `npm ci`.

## Come selezionare possibili occasioni

Il prezzo basso da solo non dimostra che un articolo sia sottocosto. Senza `ESTIMATED_RESALE_PRICE` il bot segnala tutti gli articoli restituiti entro `PRICE_TO`, anche quelli già presenti al primo avvio. Imposta facoltativamente una stima di rivendita in EUR per una ricerca omogenea: il bot richiederà `stima - prezzo - ESTIMATED_COSTS >= MIN_PROFIT`. I costi devono includere le spese previste, ad esempio spedizione, protezione acquisti e preparazione. La stima è manuale: il bot non analizza vendite concluse, condizioni, autenticità o domanda e non garantisce profitto. Non compra automaticamente.

## Sessioni, limiti e verifiche

Per verificare il catalogo senza inviare notifiche, esegui `node bot.js --check`. Non richiede credenziali Telegram, non modifica il registro e mostra per ogni ricerca il numero di articoli e i nomi dei campi, non cookie o dati di sessione. Questa prova verifica accesso e struttura della risposta, non consegna Telegram o correttezza di tutti i filtri. Se hai configurato un vecchio `VINTED_CATALOG_URL`, correggilo in `https://api.vinted.it/svc-catalogue/items`.

Il bot recupera i cookie dalla homepage e usa un User-Agent desktop. Questo non garantisce accesso: l'endpoint non è un'API pubblica stabile e Vinted può modificare risposte o richiedere verifiche. Su HTTP 401 rinnova la sessione e ritenta una sola volta. Su errori applica attese progressive; su 429 rispetta anche `Retry-After`. Non aggira CAPTCHA o blocchi 403: in questi casi verifica le condizioni d'uso e l'accesso consentito prima di riprendere.

Viene letta soltanto la prima pagina per ricerca, fino a `PER_PAGE` articoli: in ricerche molto attive alcuni annunci possono sfuggire. La deduplicazione registra solo invii confermati, ma un timeout dopo un invio accettato da Telegram o un arresto tra invio e salvataggio può comunque produrre un duplicato al tentativo successivo. Il registro non garantisce consegna esattamente una volta.

Sono necessarie connessioni HTTPS a `www.vinted.it`, `api.vinted.it` e `api.telegram.org` (oppure ai domini Vinted configurati). `VINTED_BASE_URL` indica la homepage; `VINTED_CATALOG_URL` indica separatamente il catalogo, ora `https://api.vinted.it/svc-catalogue/items`, osservato nelle richieste del sito italiano. Il vecchio `/api/v2/catalog/items` restituiva 404. Il 200 ottenuto nel browser non garantisce accesso dal bot: cookie aggiuntivi o autenticazione potrebbero essere richiesti. Non copiare manualmente cookie privati nel codice. Non inserire segreti nel codice o nei log. I test simulati verificano la logica; l'accesso reale e la consegna Telegram richiedono una prova con le proprie credenziali.
