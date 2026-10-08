# Gestione bici — 12100 Cycling Studio

Pannello per aggiungere, modificare e togliere le bici in rastrelliera sul sito
[12100 Cycling Studio](https://github.com/andreamario04040-ship-it/12100-cycling-studio).

Sta apposta **fuori dal dominio del sito**: è un sito suo, su un indirizzo suo.
Chi arriva sul sito del negozio non lo vede e non lo può nemmeno indovinare.

## Com'è fatto

Tre file e nessun server: `index.html`, `stile.css`, `app.js`. Il pannello parla
direttamente con GitHub, dal browser. Quando si preme **Pubblica**:

1. carica le foto già rimpicciolite (quattro misure in WebP, come le chiede il sito);
2. scrive `data/bici.json` nel repository del sito;
3. butta via le foto delle bici tolte;
4. fa **un commit solo** con tutto.

Da lì in poi tocca a GitHub: il workflow `Pubblica il sito` ricostruisce le schede
dentro `index.html` e pubblica. Il pannello aspetta e dice quando è online davvero.

Niente abbonamenti, niente database, niente password da custodire: i contenuti
restano nel repository del sito, in chiaro e con tutta la storia delle modifiche.

## La chiave di accesso

Serve un *fine-grained personal access token* di GitHub, di un account che abbia
accesso in scrittura al repository del sito:

1. **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. Scadenza: la più lunga disponibile. Quando scade, il pannello lo dice e se ne fa un'altra.
3. **Repository access → Only select repositories** → soltanto `12100-cycling-studio`.
4. **Permissions → Repository permissions → Contents → Read and write**. Nient'altro.

La chiave si incolla una volta sola. Non resta in chiaro: viene chiusa con un
**codice** di almeno 5 cifre scelto da chi la usa (AES-GCM, codice allungato con
PBKDF2 a 250.000 giri) e solo così finisce nel browser di quel dispositivo. Da lì
in poi si entra col codice. La chiave non passa da nessun altro posto: niente
server nostri, niente servizi di terzi.

## Cosa protegge cosa

| Se succede questo | Cosa lo ferma |
| --- | --- |
| Qualcuno trova l'indirizzo del pannello | Vede la schermata di accesso e basta: senza chiave non esiste nessun dato da leggere. |
| Qualcuno ruba il telefono o il computer | La chiave nel browser è una busta chiusa: senza il codice non si apre. Dopo 5 codici sbagliati si cancella da sola. |
| Il pannello resta aperto sul bancone | Dopo mezz'ora che non si tocca niente, la chiave si richiude da sé e riappare la richiesta del codice. Il lavoro non pubblicato resta lì. |
| Finisce codice ostile dentro la pagina | La `Content-Security-Policy` in `index.html` lascia caricare solo file del pannello e lascia parlare solo con `api.github.com` e col sito: non c'è nessun posto dove mandare la chiave. |
| Qualcuno incornicia il pannello in un'altra pagina per rubare i clic | `app.js` se ne accorge e si spegne (la regola CSP che lo vieta funziona solo negli header, che GitHub Pages non manda). |
| La chiave viene rubata lo stesso | Può solo scrivere in quel repository, e ogni modifica resta nella storia di git. Si revoca da GitHub e se ne fa un'altra: **Settings → Developer settings → Personal access tokens**. |

Se il codice si dimentica, dalla schermata di accesso si cancella la chiave e se
ne incolla una nuova (e la vecchia si revoca su GitHub).

## Quello che questa soluzione non fa

Il pannello sta sullo stesso `github.io` del sito del negozio: per il browser è la
**stessa origine**, quindi uno script servito da lì dentro potrebbe arrivare alla
busta (non al suo contenuto, che resta chiuso dal codice). Il giorno in cui si
vuole la porta vera — nessuno può nemmeno *aprire* la pagina se non è nell'elenco
— si sposta il pannello su Cloudflare Pages con Cloudflare Access davanti: è
gratis, dà un indirizzo tutto suo e chiede l'email a chi arriva, prima ancora di
servire la pagina.

## Quando il sito avrà il dominio vero

Due posti, tutti e due in cima ai file:

- `app.js` → `CONFIG.sito`: serve per le anteprime delle foto già pubblicate e per
  capire quando la pubblicazione è arrivata online davvero;
- `index.html` → la `Content-Security-Policy`: l'indirizzo del sito compare in
  `img-src` e in `connect-src`. Se non si aggiorna, il pannello smette di vedere
  le foto e di accorgersi che il sito è aggiornato.

## Dopo ogni modifica

```bash
python3 versiona.py
```

Cambia il codice di versione di `stile.css` e `app.js` dentro `index.html`. Senza,
per dieci minuti un browser può mettere insieme la pagina nuova con lo script
vecchio: con la schermata di accesso che è cambiata, vuol dire un pannello che
non si apre.

## In locale

```bash
python3 -m http.server 5189
```

e aprire http://localhost:5189.

## Font

`font/` contiene Big Shoulders e IBM Plex Sans (licenza SIL OFL, testo in `font/OFL-*.txt`),
copiati dal sito: il pannello non fa richieste a Google Fonts né ad altri server.
