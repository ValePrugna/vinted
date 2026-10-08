# Monitor Vinted con notifiche Telegram

Bot Node.js con commenti in italiano: cerca articoli, rinnova la sessione dopo HTTP 401 e invia notifiche Telegram senza duplicare gli ID già confermati nella stessa esecuzione.

## Installazione e configurazione

1. Installa Node.js 22 o successivo.
2. Apri la directory del progetto ed esegui `npm ci` per installare le dipendenze dal lockfile.
3. Su Telegram crea un bot con **@BotFather** usando `/newbot` e conserva il token.
4. Apri una conversazione con il tuo bot e invia `/start`. Recupera il tuo `chat.id` con il metodo Telegram `getUpdates` usando il token in locale. Non condividere token, risposte integrali o URL contenenti il token. Se il bot usa già un webhook, `getUpdates` non è disponibile: utilizza l'integrazione esistente per ottenere il chat ID.
5. Esegui `cp .env.example .env`. Inserisci `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` nel file `.env`, ignorato da Git.
6. Personalizza `SEARCH_TEXT`, `PRICE_TO` e `ORDER` (predefinito `newest_first`). `CRON_SCHEDULE=*/30 * * * * *` esegue il controllo ogni 30 secondi; per un controllo al minuto usa `0 * * * * *`.
7. Avvia con `npm start`. Il primo controllo è immediato. Arresta con Ctrl+C. Su un server il processo deve rimanere in esecuzione tramite un gestore di processi.
8. Esegui `npm test` per i test con servizi simulati: non richiedono credenziali e non inviano messaggi reali.

## Come selezionare possibili occasioni

Il prezzo basso da solo non dimostra che un articolo sia sottocosto. Senza `ESTIMATED_RESALE_PRICE` il bot segnala tutti gli articoli restituiti entro `PRICE_TO`, anche quelli già presenti al primo avvio. Imposta facoltativamente una stima di rivendita in EUR per una ricerca omogenea: il bot richiederà `stima - prezzo - ESTIMATED_COSTS >= MIN_PROFIT`. I costi devono includere le spese previste, ad esempio spedizione, protezione acquisti e preparazione. La stima è manuale: il bot non analizza vendite concluse, condizioni, autenticità o domanda e non garantisce profitto. Non compra automaticamente.

## Sessioni, limiti e verifiche

Per verificare il catalogo senza inviare notifiche, esegui `node bot.js --check`. Non richiede credenziali Telegram e mostra soltanto il numero di articoli e i nomi dei campi, non cookie o dati di sessione. Questa prova verifica accesso e struttura della risposta, non consegna Telegram o correttezza di tutti i filtri. Dopo un aggiornamento puoi sostituire `bot.js` mantenendo il tuo `.env`; se hai configurato un vecchio `VINTED_CATALOG_URL`, correggilo in `https://api.vinted.it/svc-catalogue/items`.

Il bot recupera i cookie dalla homepage e usa un User-Agent desktop. Questo non garantisce accesso: l'endpoint non è un'API pubblica stabile e Vinted può modificare risposte o richiedere verifiche. Su HTTP 401 rinnova la sessione e ritenta una sola volta. Su errori applica attese progressive; su 429 rispetta anche `Retry-After`. Non aggira CAPTCHA o blocchi 403: in questi casi verifica le condizioni d'uso e l'accesso consentito prima di riprendere.

Viene letta soltanto la prima pagina, fino a `PER_PAGE` articoli: in ricerche molto attive alcuni annunci possono sfuggire. Il Set è in memoria e cresce durante l'esecuzione; al riavvio gli annunci possono essere notificati di nuovo. La deduplicazione registra solo invii confermati, ma un timeout dopo un invio accettato da Telegram può comunque produrre un duplicato al tentativo successivo.

Sono necessarie connessioni HTTPS a `www.vinted.it`, `api.vinted.it` e `api.telegram.org` (oppure ai domini Vinted configurati). `VINTED_BASE_URL` indica la homepage; `VINTED_CATALOG_URL` indica separatamente il catalogo, ora `https://api.vinted.it/svc-catalogue/items`, osservato nelle richieste del sito italiano. Il vecchio `/api/v2/catalog/items` restituiva 404. Il 200 ottenuto nel browser non garantisce accesso dal bot: cookie aggiuntivi o autenticazione potrebbero essere richiesti. Non copiare manualmente cookie privati nel codice. Non inserire segreti nel codice o nei log. I test simulati verificano la logica; l'accesso reale e la consegna Telegram richiedono una prova con le proprie credenziali.
