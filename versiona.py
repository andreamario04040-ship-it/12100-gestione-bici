"""Aggiorna il codice di versione (?v=...) di stile.css e app.js in index.html.

GitHub Pages fa tenere i file in cache per 10 minuti: senza un indirizzo che cambia,
un browser può mettere insieme la pagina nuova con lo script vecchio — e con la
schermata di accesso che cambia, vuol dire un pannello che non si apre.
Da lanciare dopo ogni modifica, prima del commit:

    python3 versiona.py
"""
import hashlib
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
pagina = ROOT / "index.html"
html = pagina.read_text()

for file in ("stile.css", "app.js"):
    firma = hashlib.md5((ROOT / file).read_bytes()).hexdigest()[:10]
    html, n = re.subn(rf'{re.escape(file)}(\?v=[0-9a-f]+)?"', f'{file}?v={firma}"', html)
    if n:
        print(f"{file} v={firma}")

pagina.write_text(html)
