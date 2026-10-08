/* ==========================================================================
   Gestione bici — 12100 Cycling Studio

   Pagina statica: non c'è nessun server in mezzo. Le modifiche finiscono
   direttamente nel repository del sito (un commit solo, con foto e dati),
   e GitHub ricostruisce e pubblica il sito da sé.
   ========================================================================== */
'use strict';

/* Nessuno può incorniciare questa pagina dentro un'altra per rubare i clic:
   la regola CSP che lo vieta vale solo negli header, e GitHub Pages non li manda. */
if (window.top !== window.self) {
  document.documentElement.replaceChildren();
  window.location.replace('about:blank');
  throw new Error('Questa pagina non si apre dentro un\'altra pagina.');
}

const CONFIG = {
  utente: 'andreamario04040-ship-it',
  repo: '12100-cycling-studio',
  ramo: 'main',
  // Indirizzo del sito pubblicato: da cambiare quando arriva il dominio vero.
  sito: 'https://andreamario04040-ship-it.github.io/12100-cycling-studio',
  dati: 'data/bici.json',
  cartellaFoto: 'assets/img/bici',
  // Le stesse larghezze che il sito chiede nel srcset.
  larghezze: [480, 800, 1200, 1800],
};

const API = 'https://api.github.com';
const CASSAFORTE = '12100-gestione-cassaforte';
const VECCHIA_CHIAVE = '12100-gestione-token';   // la prima versione la teneva in chiaro
const TENTATIVI_MAX = 5;
const INATTIVITA = 30 * 60 * 1000;

const $ = (sel, dove = document) => dove.querySelector(sel);
const $$ = (sel, dove = document) => [...dove.querySelectorAll(sel)];

/* --------------------------------------------------------------- stato */
let token = '';
let dati = null;          // { aggiornato, whatsapp, bici: [...] }
let impronta = '';        // com'erano i dati appena caricati
let shaDati = '';         // sha del file data/bici.json su GitHub (per accorgersi dei conflitti)
let scelta = null;        // bici selezionata
let fotoNuove = new Map();// uid bici -> { larghezze, blobi, anteprima }
let fotoCaricate = new Map();// chiave -> anteprima, per non aspettare il sito
let pubblicando = false;
let bloccato = false;
let ultimoTocco = Date.now();

/* --------------------------------------------------------------- utilità */
function slug(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function sigla() {
  return Math.random().toString(36).slice(2, 6);
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const testoInBase64 = (t) => base64(new TextEncoder().encode(t));
const base64InTesto = (b) => new TextDecoder().decode(
  Uint8Array.from(atob(b.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

function impronteDati() {
  return JSON.stringify({ ...dati, aggiornato: '' });
}

function cambiato() {
  return Boolean(dati) && (impronteDati() !== impronta || fotoNuove.size > 0);
}

/* --------------------------------------------------------------- GitHub */
async function gh(percorso, opzioni = {}) {
  const r = await fetch(API + percorso, {
    ...opzioni,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opzioni.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!r.ok) {
    let messaggio = r.statusText;
    try { messaggio = (await r.json()).message || messaggio; } catch (_) {}
    if (r.status === 401) {
      throw new Error(`La chiave non è più valida (GitHub: «${messaggio}»). Succede quando scade o quando viene revocata: Esci e incollane una nuova.`);
    }
    if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('GitHub ha chiesto di rallentare: troppe richieste di fila. Riprova fra qualche minuto, non si è perso niente.');
    }
    if (r.status === 403) throw new Error(ERRORE_PERMESSI(messaggio));
    throw new Error(`GitHub: ${messaggio} (${r.status})`);
  }
  return r.status === 204 ? null : r.json();
}

const inRepo = (percorso) => `/repos/${CONFIG.utente}/${CONFIG.repo}${percorso}`;

/* --------------------------------------------------------------- cassaforte
   La chiave di GitHub non resta in chiaro nel browser: è chiusa con un codice
   che sa solo chi la usa (AES-GCM, codice allungato con PBKDF2). Chi arrivasse
   alla memoria del browser si porterebbe via una busta chiusa, e senza il
   codice non la apre. Dopo cinque codici sbagliati la busta si brucia.
*/
const bytesInB64 = (b) => base64(new Uint8Array(b));
const b64InBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function chiaveDiCifratura(codice, sale) {
  const grezza = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(codice), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: sale, iterations: 250000, hash: 'SHA-256' },
    grezza, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function cassaforte() {
  try { return JSON.parse(localStorage.getItem(CASSAFORTE) || 'null'); } catch (_) { return null; }
}

async function chiudiInCassaforte(chiave, codice) {
  const sale = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const chiusa = await crypto.subtle.encrypt({ name: 'AES-GCM', iv },
    await chiaveDiCifratura(codice, sale), new TextEncoder().encode(chiave));
  localStorage.setItem(CASSAFORTE, JSON.stringify({
    v: 1, sale: base64(sale), iv: base64(iv), chiusa: bytesInB64(chiusa), tentativi: 0 }));
}

async function apriCassaforte(codice) {
  const busta = cassaforte();
  if (!busta) throw new Error('Su questo dispositivo non c\'è nessuna chiave salvata.');
  // Il tentativo si conta prima di provare: ricaricare la pagina non azzera il contatore.
  busta.tentativi = (busta.tentativi || 0) + 1;
  if (busta.tentativi > TENTATIVI_MAX) {
    localStorage.removeItem(CASSAFORTE);
    throw new Error('Troppi codici sbagliati: la chiave è stata cancellata da questo dispositivo. Serve incollarne una nuova.');
  }
  localStorage.setItem(CASSAFORTE, JSON.stringify(busta));
  let aperta;
  try {
    aperta = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64InBytes(busta.iv) },
      await chiaveDiCifratura(codice, b64InBytes(busta.sale)),
      b64InBytes(busta.chiusa));
  } catch (_) {
    const restano = TENTATIVI_MAX - busta.tentativi;
    throw new Error(
      restano > 1 ? `Codice sbagliato. Restano ${restano} tentativi, poi la chiave viene cancellata da qui.`
      : restano === 1 ? 'Codice sbagliato. Resta un tentativo, poi la chiave viene cancellata da qui.'
      : 'Codice sbagliato. Era l\'ultimo tentativo.');
  }
  busta.tentativi = 0;
  localStorage.setItem(CASSAFORTE, JSON.stringify(busta));
  return new TextDecoder().decode(aperta);
}

/* --------------------------------------------------------------- accesso */
const ERRORE_PERMESSI = (detto) =>
  `Questa chiave può leggere il sito ma non scriverci, e per pubblicare serve scrivere.\n\n` +
  `Su GitHub: Settings → Developer settings → Personal access tokens → Fine-grained tokens → ` +
  'apri la chiave che hai creato e controlla due cose:\n' +
  `1. Repository access: «Only select repositories», con ${CONFIG.repo} nell'elenco ` +
  `(non «Public repositories», che è di sola lettura);\n` +
  `2. Repository permissions → Contents: «Read and write» (è lì, non fra le Account permissions).\n\n` +
  `Si possono cambiare sulla chiave che hai già, senza rifarla: la chiave resta la stessa.` +
  (detto ? `\n\nGitHub dice: «${detto}».` : '');

async function verifica(chiave) {
  token = chiave;
  const utente = await gh('/user');
  const repo = await gh(inRepo(''));
  if (!repo.permissions || !repo.permissions.push) {
    throw new Error(`Con questo account non si può scrivere in ${CONFIG.repo}: ` +
      'chiedi a chi possiede il sito di aggiungerti come collaboratore.');
  }
  // Il campo qui sopra dice che ruolo ha la persona nel repository, non cosa può
  // fare la chiave: una chiave di sola lettura lo supera. L'unico modo onesto di
  // saperlo è provare a scrivere. Un blob è la prova più innocua che esista:
  // crea un oggetto sciolto, senza commit e senza comparire da nessuna parte.
  try {
    await gh(inRepo('/git/blobs'), {
      method: 'POST',
      body: JSON.stringify({ content: 'prova', encoding: 'utf-8' }),
    });
  } catch (e) {
    throw new Error(e.message.startsWith('Questa chiave') ? e.message : ERRORE_PERMESSI(''));
  }
  return utente;
}

function avvia() {
  localStorage.removeItem(VECCHIA_CHIAVE);
  if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
    return mostraAccesso({ errore: 'Questa pagina va aperta in https: altrimenti la chiave non si può mettere al sicuro.' });
  }
  mostraAccesso();
}

function mostraAccesso({ errore = '', blocco = false } = {}) {
  const haChiave = Boolean(cassaforte());
  $('#app').hidden = !blocco;          // sotto il velo del blocco l'app resta com'era
  $('#accesso').hidden = false;
  $('#accesso').classList.toggle('accesso--blocco', blocco);
  $('#riga-token').hidden = haChiave;
  $('#accesso-aiuto').hidden = haChiave;
  $('#btn-dimentica').hidden = !haChiave;
  $('#accesso-titolo').textContent = blocco ? 'Chiuso a chiave' : 'Gestione bici';
  $('#eti-pin').textContent = haChiave ? 'Codice' : 'Scegli un codice';
  $('#campo-pin').placeholder = haChiave ? '' : 'almeno 5 cifre';
  $('#btn-entra').textContent = blocco ? 'Riapri' : 'Entra';
  $('#accesso-testo').textContent = blocco
    ? 'Era da un po\' che non toccavi niente, così ho richiuso la chiave. Il codice la riapre: quello che stavi facendo è ancora qui.'
    : haChiave
      ? 'Il codice riapre la chiave salvata su questo dispositivo.'
      : 'Qui dentro si aggiungono, si modificano e si tolgono le bici in rastrelliera sul sito. La chiave di accesso si incolla una volta sola: resta su questo dispositivo, chiusa con un codice che scegli tu.';
  const stato = $('#accesso-stato');
  stato.textContent = errore;
  stato.className = 'barra__stato' + (errore ? ' is-errore' : '');
  $('#campo-pin').value = '';
  (haChiave ? $('#campo-pin') : $('#campo-token')).focus();
}

$('#form-accesso').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-entra');
  const stato = $('#accesso-stato');
  const codice = $('#campo-pin').value.trim();
  btn.disabled = true;
  stato.className = 'barra__stato';
  try {
    if (cassaforte()) {
      stato.innerHTML = '<span class="filo"></span>Apro la chiave…';
      const chiave = await apriCassaforte(codice);
      if (bloccato) sblocca(chiave);
      else await apriApp(await verifica(chiave));
    } else {
      if (codice.length < 5) throw new Error('Il codice deve avere almeno 5 cifre.');
      stato.innerHTML = '<span class="filo"></span>Controllo la chiave…';
      const utente = await verifica($('#campo-token').value.trim());
      await chiudiInCassaforte(token, codice);
      $('#campo-token').value = '';
      await apriApp(utente);
    }
  } catch (err) {
    token = '';
    if (!cassaforte()) mostraAccesso({ errore: err.message });
    else {
      stato.className = 'barra__stato is-errore';
      stato.textContent = err.message;
    }
  } finally {
    btn.disabled = false;
  }
});

$('#btn-dimentica').addEventListener('click', () => {
  if (!confirm('Cancello la chiave da questo dispositivo?\n\nDopo serve incollarne una nuova, e quella vecchia conviene revocarla su GitHub.')) return;
  localStorage.removeItem(CASSAFORTE);
  token = '';
  mostraAccesso();
});

$('#btn-esci').addEventListener('click', () => {
  if (cambiato() && !confirm('Ci sono modifiche non pubblicate: uscendo si perdono. Esco comunque?')) return;
  localStorage.removeItem(CASSAFORTE);
  location.reload();
});

/* Se si resta fermi mezz'ora, la chiave si richiude: un telefono dimenticato
   sul bancone non è una porta aperta. Il lavoro in corso resta dov'è. */
function blocca() {
  if (!token || bloccato) return;
  token = '';
  bloccato = true;
  mostraAccesso({ blocco: true });
}

function sblocca(chiave) {
  token = chiave;
  bloccato = false;
  ultimoTocco = Date.now();
  $('#accesso').hidden = true;
  $('#accesso').classList.remove('accesso--blocco');
  $('#app').hidden = false;
}

['pointerdown', 'keydown', 'focusin'].forEach((evento) =>
  addEventListener(evento, () => { ultimoTocco = Date.now(); }, { passive: true }));
setInterval(() => {
  if (token && !pubblicando && Date.now() - ultimoTocco > INATTIVITA) blocca();
}, 20000);

async function apriApp(utente) {
  $('#accesso').hidden = true;
  $('#accesso').classList.remove('accesso--blocco');
  $('#app').hidden = false;
  $('#chi').textContent = utente.login;
  $('#link-sito').href = CONFIG.sito;
  ultimoTocco = Date.now();
  if (!dati) await caricaDati();
}

/* --------------------------------------------------------------- dati */
async function caricaDati() {
  avvisa('<span class="filo"></span>Scarico le bici dal sito…');
  const file = await gh(inRepo(`/contents/${CONFIG.dati}?ref=${CONFIG.ramo}`));
  shaDati = file.sha;
  dati = JSON.parse(base64InTesto(file.content));
  dati.bici.forEach((b) => { b._uid = sigla() + sigla(); });
  impronta = impronteDati();
  fotoNuove.clear();
  scelta = null;
  disegnaLista();
  disegnaScheda();
  aggiorna();
  avvisa('');
}

/* --------------------------------------------------------------- elenco */
function urlFoto(bici) {
  const nuova = fotoNuove.get(bici._uid);
  if (nuova) return nuova.anteprima;
  const f = bici.foto;
  if (!f || !f.chiave) return '';
  if (fotoCaricate.has(f.chiave)) return fotoCaricate.get(f.chiave);
  if (f.sorgente === 'unsplash') {
    return `https://images.unsplash.com/${f.chiave}?auto=format&fit=crop&w=400&q=70`;
  }
  return `${CONFIG.sito}/assets/img/${f.chiave}-480.webp`;
}

function disegnaLista() {
  const lista = $('#lista');
  lista.textContent = '';
  const pubblicate = dati.bici.filter((b) => b.stato !== 'bozza').length;
  $('#conta').textContent = `${pubblicate} sul sito` +
    (dati.bici.length - pubblicate ? `, ${dati.bici.length - pubblicate} in bozza` : '');

  dati.bici.forEach((bici, i) => {
    const li = document.createElement('li');
    li.className = 'riga' + (bici === scelta ? ' is-sel' : '');
    li.draggable = true;
    li.dataset.i = i;
    li.tabIndex = 0;

    const url = urlFoto(bici);
    const foto = url
      ? `<img class="riga__foto" src="${fuga(url)}" alt="">`
      : '<span class="riga__foto riga__foto--vuota">foto<br>?</span>';

    const dettagli = [bici.prezzo, bici.taglia].filter(Boolean).join(' · ');
    li.innerHTML = `
      ${foto}
      <div>
        <div class="riga__nome">${fuga(bici.titolo || 'Senza nome')}</div>
        <div class="riga__sotto">${bici.stato === 'bozza' ? '<span class="riga__tag">bozza</span> ' : ''}${fuga(dettagli)}</div>
      </div>
      <div class="riga__ordine">
        <button type="button" data-su aria-label="Sposta su" ${i === 0 ? 'disabled' : ''}><svg aria-hidden="true"><use href="#i-su"/></svg></button>
        <button type="button" data-giu aria-label="Sposta giù" ${i === dati.bici.length - 1 ? 'disabled' : ''}><svg aria-hidden="true"><use href="#i-giu"/></svg></button>
      </div>`;

    li.addEventListener('click', (e) => {
      if (e.target.closest('[data-su]')) return sposta(i, -1);
      if (e.target.closest('[data-giu]')) return sposta(i, 1);
      seleziona(bici);
    });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); seleziona(bici); }
    });
    const miniatura = $('img.riga__foto', li);
    if (miniatura) miniatura.style.objectPosition = `50% ${inquadraturaDi(bici)}%`;
    trascina(li);
    lista.append(li);
  });
}

function sposta(i, verso) {
  const j = i + verso;
  if (j < 0 || j >= dati.bici.length) return;
  [dati.bici[i], dati.bici[j]] = [dati.bici[j], dati.bici[i]];
  disegnaLista();
  aggiorna();
}

let daDove = null;
function trascina(li) {
  li.addEventListener('dragstart', (e) => {
    daDove = Number(li.dataset.i);
    li.classList.add('is-trascina');
    e.dataTransfer.effectAllowed = 'move';
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('is-trascina');
    $$('.riga').forEach((r) => r.classList.remove('is-sopra'));
  });
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    $$('.riga').forEach((r) => r.classList.toggle('is-sopra', r === li));
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const a = daDove, b = Number(li.dataset.i);
    if (a === null || a === b) return;
    dati.bici.splice(b, 0, ...dati.bici.splice(a, 1));
    daDove = null;
    disegnaLista();
    aggiorna();
  });
}

function fuga(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function seleziona(bici) {
  scelta = bici;
  $('#app').classList.add('is-scheda');
  disegnaLista();
  disegnaScheda();
}

$('#btn-indietro').addEventListener('click', () => $('#app').classList.remove('is-scheda'));

$('#btn-aggiungi').addEventListener('click', () => {
  const bici = {
    _uid: sigla() + sigla(),
    id: '',
    stato: 'bozza',
    titolo: '',
    prezzo: '',
    taglia: '',
    descrizione: '',
    modelli: '',
    cta: { tipo: 'whatsapp', testo: 'Chiedi disponibilità', messaggio: 'Ciao! Vorrei informazioni su questa bici.' },
    foto: {},
  };
  dati.bici.unshift(bici);
  seleziona(bici);
  aggiorna();
  const primo = $('[data-campo="titolo"]');
  if (primo) primo.focus();
});

/* --------------------------------------------------------------- scheda */
const inquadraturaDi = (bici) => (bici.foto && bici.foto.inquadratura != null ? bici.foto.inquadratura : 50);

function disegnaScheda() {
  const dove = $('#scheda');
  dove.textContent = '';
  if (!scelta) {
    dove.innerHTML = '<p class="scheda__vuota">Scegli una bici dall\'elenco, oppure aggiungine una.</p>';
    return;
  }
  const bici = scelta;
  dove.append($('#modello-scheda').content.cloneNode(true));

  $('[data-titolo-scheda]', dove).textContent = bici.titolo || 'Nuova bici';
  $('[data-via-scheda]', dove).textContent = bici.stato === 'bozza' ? 'In bozza · non si vede sul sito' : 'Pubblicata sul sito';

  // campi di testo
  $$('[data-campo]', dove).forEach((el) => {
    el.value = bici[el.dataset.campo] || '';
    el.addEventListener('input', () => {
      bici[el.dataset.campo] = el.value;
      if (el.dataset.campo === 'titolo') $('[data-titolo-scheda]', dove).textContent = el.value || 'Nuova bici';
      disegnaLista();
      aggiorna();
    });
  });

  // bottone
  const tipo = $('[data-cta-tipo]', dove);
  bici.cta = bici.cta || { tipo: 'niente' };
  tipo.value = bici.cta.tipo || 'niente';
  const mostraCta = () => {
    $('[data-riga-cta-testo]', dove).hidden = tipo.value === 'niente';
    $('[data-riga-cta-messaggio]', dove).hidden = tipo.value !== 'whatsapp';
    $('[data-riga-cta-url]', dove).hidden = tipo.value !== 'link';
  };
  tipo.addEventListener('change', () => { bici.cta.tipo = tipo.value; mostraCta(); aggiorna(); });
  mostraCta();
  const lega = (sel, chiave) => {
    const el = $(sel, dove);
    el.value = bici.cta[chiave] || '';
    el.addEventListener('input', () => { bici.cta[chiave] = el.value; aggiorna(); });
  };
  lega('[data-cta-testo]', 'testo');
  lega('[data-cta-messaggio]', 'messaggio');
  lega('[data-cta-url]', 'url');

  // stato
  $$('[data-stato] input', dove).forEach((r) => {
    r.checked = (bici.stato || 'pubblicata') === r.value;
    r.addEventListener('change', () => {
      bici.stato = r.value;
      $('[data-via-scheda]', dove).textContent = bici.stato === 'bozza' ? 'In bozza · non si vede sul sito' : 'Pubblicata sul sito';
      disegnaLista();
      aggiorna();
    });
  });

  // elimina
  $('[data-elimina]', dove).addEventListener('click', () => {
    if (!confirm(`Elimino «${bici.titolo || 'questa bici'}» dal sito?`)) return;
    dati.bici.splice(dati.bici.indexOf(bici), 1);
    fotoNuove.delete(bici._uid);
    scelta = null;
    $('#app').classList.remove('is-scheda');
    disegnaLista();
    disegnaScheda();
    aggiorna();
  });

  disegnaFoto(dove, bici);
}

function disegnaFoto(dove, bici) {
  const quadro = $('[data-quadro]', dove);
  const vuoto = $('[data-quadro-vuoto]', dove);
  const nota = $('[data-foto-nota]', dove);
  const file = $('[data-file]', dove);
  const rigaInq = $('[data-riga-inquadratura]', dove);
  const inq = $('[data-inquadratura]', dove);
  const alt = $('[data-alt]', dove);

  const url = urlFoto(bici);
  $$('img', quadro).forEach((i) => i.remove());
  if (url) {
    const img = new Image();
    img.src = url;
    img.alt = '';
    img.style.objectPosition = `50% ${inquadraturaDi(bici)}%`;
    quadro.append(img);
    vuoto.hidden = true;
    rigaInq.hidden = false;
    inq.value = inquadraturaDi(bici);
    inq.addEventListener('input', () => {
      bici.foto.inquadratura = Number(inq.value);
      img.style.objectPosition = `50% ${inq.value}%`;
      disegnaLista();
      aggiorna();
    });
  } else {
    vuoto.hidden = false;
    rigaInq.hidden = true;
  }

  alt.value = (bici.foto && bici.foto.alt) || '';
  alt.addEventListener('input', () => {
    bici.foto = bici.foto || {};
    bici.foto.alt = alt.value;
    aggiorna();
  });

  $('[data-scegli-foto]', dove).addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const scelto = file.files[0];
    if (!scelto) return;
    nota.innerHTML = '<span class="filo"></span>Preparo la foto…';
    try {
      const pronta = await preparaFoto(scelto);
      fotoNuove.set(bici._uid, pronta);
      bici.foto = {
        sorgente: 'sito',
        chiave: '',           // il nome del file si decide quando si pubblica
        alt: (bici.foto && bici.foto.alt) || '',
        inquadratura: inquadraturaDi(bici),
        larghezze: pronta.larghezze,
      };
      disegnaScheda();
      $('[data-foto-nota]', $('#scheda')).textContent =
        pronta.avviso || 'Foto pronta. Si carica sul sito quando premi Pubblica.';
      disegnaLista();
      aggiorna();
    } catch (e) {
      nota.textContent = `Non riesco a leggere questa foto: ${e.message}`;
    }
    file.value = '';
  });
}

/* --------------------------------------------------------------- foto */
function caricaImmagine(fileFoto) {
  return new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => no(new Error('formato non riconosciuto'));
    img.src = URL.createObjectURL(fileFoto);
  });
}

async function preparaFoto(fileFoto) {
  const img = await caricaImmagine(fileFoto);
  let larghezze = CONFIG.larghezze.filter((w) => w <= img.naturalWidth);
  if (!larghezze.length) larghezze = [CONFIG.larghezze[0]];
  const blobi = {};
  for (const w of larghezze) {
    const scala = w / img.naturalWidth;
    const tela = document.createElement('canvas');
    tela.width = w;
    tela.height = Math.max(1, Math.round(img.naturalHeight * scala));
    const c = tela.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, 0, 0, tela.width, tela.height);
    blobi[w] = await new Promise((ok, no) => tela.toBlob(
      (b) => (b ? ok(b) : no(new Error('il browser non riesce a convertirla'))), 'image/webp', 0.82));
  }
  const grande = larghezze[larghezze.length - 1];
  return {
    larghezze,
    blobi,
    anteprima: URL.createObjectURL(blobi[larghezze[0]]),
    avviso: grande < 1200
      ? `Attenzione: la foto è larga ${img.naturalWidth} pixel, sul sito può risultare un po' sfocata. Meglio almeno 1200.`
      : '',
  };
}

/* --------------------------------------------------------------- pubblicazione */
function aggiorna() {
  const n = fotoNuove.size;
  $('#btn-pubblica').disabled = pubblicando || !cambiato();
  if (pubblicando) return;
  if (!cambiato()) return avvisa('Tutto pubblicato.', 'is-ok');
  avvisa(`Modifiche da pubblicare${n ? ` · ${n} foto nuov${n === 1 ? 'a' : 'e'}` : ''}.`);
}

function avvisa(html, classe = '') {
  const el = $('#stato');
  el.className = 'barra__stato ' + classe;
  el.innerHTML = html;
}

function nuovoId(titolo, usati) {
  const base = slug(titolo) || 'bici';
  let id = base, n = 2;
  while (usati.has(id)) id = `${base}-${n++}`;
  usati.add(id);
  return id;
}

function controlla() {
  const problemi = [];
  for (const bici of dati.bici) {
    const nome = bici.titolo.trim() || 'una bici senza nome';
    const haFoto = fotoNuove.has(bici._uid) || (bici.foto && bici.foto.chiave);
    if (bici.stato === 'bozza') continue;
    if (!bici.titolo.trim()) problemi.push('C\'è una bici senza nome.');
    if (!haFoto) problemi.push(`${nome}: non ha una foto.`);
    else if (!((bici.foto.alt || '').trim())) problemi.push(`${nome}: manca la descrizione della foto.`);
  }
  return problemi;
}

async function pubblica() {
  const problemi = controlla();
  if (problemi.length && !confirm(
      'Prima di pubblicare:\n\n' + problemi.join('\n') + '\n\nPubblico lo stesso?')) return;
  pubblicando = true;
  $('#btn-pubblica').disabled = true;
  try {
    // 1. nessuno ha cambiato le bici nel frattempo?
    const adesso = await gh(inRepo(`/contents/${CONFIG.dati}?ref=${CONFIG.ramo}`));
    if (adesso.sha !== shaDati) {
      throw new Error('Le bici sono state cambiate altrove da quando hai aperto questa pagina. Ricarica la pagina (si perdono le modifiche di adesso) e rifalle.');
    }

    // 2. nomi dei file: ogni bici tiene lo stesso id per sempre, le foto nuove
    //    prendono una sigla diversa così i browser non mostrano quella vecchia.
    const usati = new Set(dati.bici.map((b) => b.id).filter(Boolean));
    for (const bici of dati.bici) {
      if (!bici.id) bici.id = nuovoId(bici.titolo, usati);
      if (fotoNuove.has(bici._uid)) bici.foto.chiave = `bici/${bici.id}-${sigla()}`;
    }

    // 3. le foto diventano blob su GitHub
    const albero = [];
    let fatte = 0;
    for (const bici of dati.bici) {
      const nuova = fotoNuove.get(bici._uid);
      if (!nuova) continue;
      for (const w of nuova.larghezze) {
        avvisa(`<span class="filo"></span>Carico le foto… ${++fatte} di ${totaleFoto()}`);
        const bytes = new Uint8Array(await nuova.blobi[w].arrayBuffer());
        const blob = await gh(inRepo('/git/blobs'), {
          method: 'POST',
          body: JSON.stringify({ content: base64(bytes), encoding: 'base64' }),
        });
        albero.push({ path: `assets/img/${bici.foto.chiave}-${w}.webp`, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }

    // 4. le vecchie foto che non servono più
    for (const percorso of await fotoDaButtare()) {
      albero.push({ path: percorso, mode: '100644', type: 'blob', sha: null });
    }

    // 5. il file delle bici
    avvisa('<span class="filo"></span>Salvo le bici…');
    dati.aggiornato = new Date().toISOString();
    const daSalvare = {
      aggiornato: dati.aggiornato,
      whatsapp: dati.whatsapp,
      bici: dati.bici.map(ripulisci),
    };
    albero.push({
      path: CONFIG.dati, mode: '100644', type: 'blob',
      content: JSON.stringify(daSalvare, null, 2) + '\n',
    });

    // 6. un commit solo
    const ref = await gh(inRepo(`/git/ref/heads/${CONFIG.ramo}`));
    const padre = await gh(inRepo(`/git/commits/${ref.object.sha}`));
    const nuovoAlbero = await gh(inRepo('/git/trees'), {
      method: 'POST',
      body: JSON.stringify({ base_tree: padre.tree.sha, tree: albero }),
    });
    const commit = await gh(inRepo('/git/commits'), {
      method: 'POST',
      body: JSON.stringify({ message: messaggioCommit(), tree: nuovoAlbero.sha, parents: [ref.object.sha] }),
    });
    await gh(inRepo(`/git/refs/heads/${CONFIG.ramo}`), {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha }),
    });

    // 7. aspetta che il sito sia online
    for (const bici of dati.bici) {
      const nuova = fotoNuove.get(bici._uid);
      if (nuova) fotoCaricate.set(bici.foto.chiave, nuova.anteprima);
    }
    fotoNuove.clear();
    impronta = impronteDati();
    const nuovo = await gh(inRepo(`/contents/${CONFIG.dati}?ref=${CONFIG.ramo}`));
    shaDati = nuovo.sha;
    disegnaLista();
    disegnaScheda();
    await aspettaIlSito(dati.aggiornato);
  } catch (e) {
    avvisa(fuga(e.message).replace(/\n/g, '<br>'), 'is-errore');
  } finally {
    pubblicando = false;
    $('#btn-pubblica').disabled = !cambiato();
  }
}

const totaleFoto = () => [...fotoNuove.values()].reduce((n, f) => n + f.larghezze.length, 0);

function ripulisci(bici) {
  const { _uid, ...resto } = bici;
  const foto = resto.foto && resto.foto.chiave ? { ...resto.foto } : {};
  if (foto.inquadratura === 50) delete foto.inquadratura;
  return { ...resto, foto };
}

async function fotoDaButtare() {
  const vive = new Set();
  for (const bici of dati.bici) {
    if (bici.foto && bici.foto.sorgente === 'sito' && bici.foto.chiave) {
      for (const w of bici.foto.larghezze || CONFIG.larghezze) {
        vive.add(`assets/img/${bici.foto.chiave}-${w}.webp`);
      }
    }
  }
  let elenco = [];
  try {
    elenco = await gh(inRepo(`/contents/${CONFIG.cartellaFoto}?ref=${CONFIG.ramo}`));
  } catch (_) {
    return [];   // la cartella non esiste ancora
  }
  return (Array.isArray(elenco) ? elenco : [])
    .filter((f) => f.type === 'file' && !vive.has(f.path))
    .map((f) => f.path);
}

function messaggioCommit() {
  const sul = dati.bici.filter((b) => b.stato !== 'bozza');
  const bozze = dati.bici.length - sul.length;
  const nomi = sul.map((b) => b.titolo).filter(Boolean).join(', ');
  return `Bici in rastrelliera: ${sul.length}${bozze ? ` (piu' ${bozze} in bozza)` : ''}` +
    `\n\n${nomi}\n\nAggiornate dal pannello di gestione.`;
}

async function aspettaIlSito(marca) {
  const fine = Date.now() + 4 * 60 * 1000;
  while (Date.now() < fine) {
    const attesa = Math.round((fine - Date.now()) / 1000);
    avvisa(`<span class="filo"></span>Salvato. Il sito si sta aggiornando… <strong>ancora ${attesa} secondi al massimo</strong>`);
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const r = await fetch(`${CONFIG.sito}/data/pubblicato.json?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok && (await r.json()).aggiornato === marca) {
        return avvisa('<strong>Online.</strong> Le bici sono sul sito.', 'is-ok');
      }
    } catch (_) {
      // il sito non si lascia leggere da qui: si controlla a mano
      return avvisa('Salvato su GitHub. Il sito si aggiorna da sé entro un paio di minuti.', 'is-ok');
    }
  }
  avvisa('Salvato, ma il sito non risulta ancora aggiornato. Controlla la scheda Actions del repository su GitHub.', 'is-errore');
}

$('#btn-pubblica').addEventListener('click', pubblica);

window.addEventListener('beforeunload', (e) => {
  if (cambiato()) { e.preventDefault(); e.returnValue = ''; }
});

avvia();
