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

La chiave si incolla una volta e resta nel browser di quel dispositivo
(`localStorage`). Non passa da nessun'altra parte. Con **Esci** si cancella.

> Se la chiave finisce in mano a qualcuno, può solo scrivere in quel repository:
> si revoca da GitHub e se ne fa un'altra. Conviene comunque non usare il pannello
> su computer condivisi.

## Quando il sito avrà il dominio vero

In `app.js`, in cima, cambiare `CONFIG.sito` con l'indirizzo nuovo: serve al pannello
per mostrare le anteprime delle foto già pubblicate e per capire quando il sito si è
aggiornato. Il resto non cambia.

## In locale

```bash
python3 -m http.server 5189
```

e aprire http://localhost:5189.

## Font

`font/` contiene Big Shoulders e IBM Plex Sans (licenza SIL OFL, testo in `font/OFL-*.txt`),
copiati dal sito: il pannello non fa richieste a Google Fonts né ad altri server.
