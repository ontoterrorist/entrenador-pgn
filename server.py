"""Entrenador PGN: servidor local, solo biblioteca estandar.

Sirve la app en 127.0.0.1, guarda los cursos (PGN) y el progreso de repeticion
espaciada en ./data, y se apaga solo cuando ya no queda ninguna pestana abierta:
cada pestana mantiene abierto un canal SSE (/api/vida) y el vigilante cuenta cuantos
hay. Con --siempre no se apaga nunca.

    py server.py                 # abre el navegador y vive mientras la pestana viva
    py server.py --siempre       # modo permanente
    py server.py --sin-navegador --puerto 8800
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import socket
import sys
import threading
import time
import urllib.request
import uuid
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

APP = "entrenador-pgn"
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
CURSOS_DIR = DATA / "cursos"
PAPELERA = DATA / "papelera"
COPIAS = DATA / "copias"
CURSOS_JSON = DATA / "cursos.json"
PROGRESO_JSON = DATA / "progreso.json"
CATALOGO_CSV = DATA / "catalogo_chessable_2020.csv"

PUERTO_BASE = 8777  # 8765: tablero de analisis; 8766: watermarks-remover
GRACIA = 20  # s sin pestanas antes de apagarse (cubre recargas)
ESPERA_PRIMERA = 120  # s para que llegue la primera pestana
LATIDO = 5  # s entre pings SSE (asi se detecta la pestana cerrada)
MAX_CUERPO = 64 * 1024 * 1024
COPIAS_MAX = 15

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",  # el registro de Windows a veces dice text/plain
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json; charset=utf-8",
}

bloqueo = threading.Lock()  # serializa lecturas/escrituras de data/
parar = threading.Event()


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


# ---------------------------------------------------------------- persistencia


def leer_json(ruta: Path, defecto):
    try:
        return json.loads(ruta.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return defecto
    except json.JSONDecodeError:
        roto = ruta.with_suffix(f".roto-{int(time.time())}.json")
        shutil.copy2(ruta, roto)
        log(f"{ruta.name} estaba corrupto; copia en {roto.name}")
        return defecto


def escribir_atomico(ruta: Path, texto: str) -> None:
    tmp = ruta.with_suffix(ruta.suffix + ".tmp")
    tmp.write_text(texto, encoding="utf-8")
    for intento in range(6):  # antivirus/indexador pueden tener el destino abierto un instante
        try:
            os.replace(tmp, ruta)
            return
        except PermissionError:
            if intento == 5:
                raise
            time.sleep(0.05 * (intento + 1))


def escribir_json(ruta: Path, datos) -> None:
    escribir_atomico(ruta, json.dumps(datos, ensure_ascii=False, separators=(",", ":")))


def copia_de_arranque() -> None:
    """Una copia del progreso por arranque; se guardan las ultimas COPIAS_MAX."""
    if not PROGRESO_JSON.exists():
        return
    COPIAS.mkdir(exist_ok=True)
    shutil.copy2(PROGRESO_JSON, COPIAS / f"progreso-{datetime.now():%Y%m%d-%H%M%S}.json")
    for vieja in sorted(COPIAS.glob("progreso-*.json"))[:-COPIAS_MAX]:
        vieja.unlink(missing_ok=True)


def cursos() -> list[dict]:
    return leer_json(CURSOS_JSON, [])


def progreso() -> dict:
    return leer_json(PROGRESO_JSON, {"rev": 0, "data": None})


# ---------------------------------------------------------------- catalogo


def _int(v: str):
    v = (v or "").replace(",", "").strip()
    try:
        return int(float(v))
    except ValueError:
        return None


def _float(v: str):
    try:
        return float((v or "").replace(",", "").strip())
    except ValueError:
        return None


def _autor(v: str) -> str:
    partes = (v or "").split()
    if len(partes) > 1 and partes[0] == partes[1]:  # "GM GM Pascal Charbonneau"
        partes = partes[1:]
    return " ".join(partes)


def catalogo() -> list[dict]:
    if not CATALOGO_CSV.exists():
        return []
    filas = []
    with CATALOGO_CSV.open(encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            try:
                fecha = datetime.strptime(r["released_on"].strip(), "%b %d, %Y").date().isoformat()
            except ValueError:
                fecha = None
            filas.append(
                {
                    "link": "https://www.chessable.com/" + r["course_link"].lstrip("/"),
                    "titulo": r["course_title"],
                    "tipo": r["course_type"].replace(" course", ""),
                    "autor": _autor(r["author"]),
                    "precio": _float(r["price"]),
                    "precioVideo": _float(r["price_with_video"]),
                    "rating": _float(r["course_rating"]),
                    "votos": _int(r["course_rating_count"]),
                    "color": {"white pieces": "w", "black pieces": "b"}.get(r["target_color"], "ambos"),
                    "niveles": [k for k in ("beginning", "casual", "intermediate", "advanced", "expert") if r[k] == "1"],
                    "idioma": r["language"],
                    "palabras": _int(r["instruction_word_count"]),
                    "video": r["free_video"] or None,
                    "variantes": _int(r["trainable_variations"]),
                    "profundidad": _float(r["avg_line_depth"]),
                    "fecha": fecha,
                    "soporte": r["support_level"],
                    "seccion": r["section"],
                }
            )
    return filas


# ---------------------------------------------------------------- ciclo de vida


class Vida:
    """Cuenta pestanas conectadas por SSE y apaga el servidor cuando no queda ninguna."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.pestanas = 0
        self.alguna_vez = False
        self.vacio_desde = time.monotonic()

    def entra(self) -> None:
        with self.lock:
            self.pestanas += 1
            self.alguna_vez = True
            n = self.pestanas
        log(f"pestana conectada ({n} abiertas)")

    def sale(self) -> None:
        with self.lock:
            self.pestanas -= 1
            n = self.pestanas
            if n == 0:
                self.vacio_desde = time.monotonic()
        log(f"pestana cerrada ({n} abiertas)")

    def vigilar(self, servidor: ThreadingHTTPServer) -> None:
        while not parar.wait(2):
            with self.lock:
                n, alguna, desde = self.pestanas, self.alguna_vez, self.vacio_desde
            limite = GRACIA if alguna else ESPERA_PRIMERA
            if n == 0 and time.monotonic() - desde > limite:
                log("no queda ninguna pestana abierta: apagando")
                parar.set()
                servidor.shutdown()
                return


vida = Vida()


# ---------------------------------------------------------------- HTTP

RUTA_CURSO = re.compile(r"^/api/cursos/([0-9a-f]{12})(\.pgn)?$")


class Manejador(BaseHTTPRequestHandler):
    server_version = "EntrenadorPGN/1"
    puerto = PUERTO_BASE

    def log_message(self, fmt, *args):  # silencio salvo errores
        pass

    def log_error(self, fmt, *args):
        log("HTTP " + fmt % args)

    # -- utilidades

    def _host_ok(self) -> bool:
        # Anti DNS-rebinding: solo se contesta a quien nos llama por loopback.
        host = (self.headers.get("Host") or "").lower()
        return host in {f"127.0.0.1:{self.puerto}", f"localhost:{self.puerto}"}

    def _escritura_ok(self) -> bool:
        # Anti CSRF: una web ajena no puede anadir esta cabecera sin preflight CORS,
        # y aqui no se contesta ningun preflight.
        return self.headers.get("X-Entrenador") == "1"

    def _enviar(self, codigo: int, cuerpo: bytes, tipo: str, extra: dict | None = None) -> None:
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(cuerpo)

    def _json(self, datos, codigo: int = 200) -> None:
        self._enviar(codigo, json.dumps(datos, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _error(self, codigo: int, msg: str) -> None:
        self._json({"error": msg}, codigo)

    def _cuerpo(self):
        largo = int(self.headers.get("Content-Length") or 0)
        if largo > MAX_CUERPO:
            raise ValueError("cuerpo demasiado grande")
        return json.loads(self.rfile.read(largo).decode("utf-8")) if largo else {}

    # -- verbos

    def do_GET(self):
        if not self._host_ok():
            return self._error(403, "host no permitido")
        ruta = unquote(urlparse(self.path).path)
        if ruta == "/api/ping":
            return self._json({"app": APP, "pid": os.getpid()})
        if ruta == "/api/vida":
            return self._sse()
        if ruta == "/api/estado":
            with bloqueo:
                return self._json({"cursos": cursos(), "progreso": progreso()})
        if ruta == "/api/catalogo":
            return self._json(catalogo())
        m = RUTA_CURSO.match(ruta)
        if m and m.group(2):
            archivo = CURSOS_DIR / f"{m.group(1)}.pgn"
            if not archivo.exists():
                return self._error(404, "curso no encontrado")
            return self._enviar(200, archivo.read_bytes(), "text/plain; charset=utf-8")
        return self._estatico(ruta)

    do_HEAD = do_GET

    def do_POST(self):
        if not self._host_ok() or not self._escritura_ok():
            return self._error(403, "peticion no permitida")
        ruta = urlparse(self.path).path
        try:
            cuerpo = self._cuerpo()
        except (ValueError, UnicodeDecodeError) as e:
            return self._error(400, str(e))
        if ruta == "/api/progreso":
            return self._guardar_progreso(cuerpo)
        if ruta == "/api/cursos":
            return self._crear_curso(cuerpo)
        m = RUTA_CURSO.match(ruta)
        if m and not m.group(2):
            return self._editar_curso(m.group(1), cuerpo)
        return self._error(404, "ruta desconocida")

    def do_DELETE(self):
        if not self._host_ok() or not self._escritura_ok():
            return self._error(403, "peticion no permitida")
        m = RUTA_CURSO.match(urlparse(self.path).path)
        if not m or m.group(2):
            return self._error(404, "ruta desconocida")
        cid = m.group(1)
        with bloqueo:
            lista = cursos()
            if not any(c["id"] == cid for c in lista):
                return self._error(404, "curso no encontrado")
            escribir_json(CURSOS_JSON, [c for c in lista if c["id"] != cid])
            archivo = CURSOS_DIR / f"{cid}.pgn"
            if archivo.exists():  # a la papelera, no se borra
                PAPELERA.mkdir(exist_ok=True)
                shutil.move(str(archivo), PAPELERA / f"{cid}-{datetime.now():%Y%m%d-%H%M%S}.pgn")
        log(f"curso {cid} enviado a la papelera")
        return self._json({"ok": True})

    # -- acciones

    def _guardar_progreso(self, cuerpo: dict):
        if not isinstance(cuerpo.get("data"), dict):
            return self._error(400, "falta data")
        with bloqueo:
            actual = progreso()
            if cuerpo.get("baseRev") != actual["rev"]:
                return self._json({"error": "conflicto", "rev": actual["rev"]}, 409)
            nuevo = {"rev": actual["rev"] + 1, "guardado": datetime.now().isoformat(timespec="seconds"), "data": cuerpo["data"]}
            escribir_json(PROGRESO_JSON, nuevo)
        return self._json({"rev": nuevo["rev"]})

    def _crear_curso(self, cuerpo: dict):
        pgn = cuerpo.get("pgn")
        nombre = (cuerpo.get("nombre") or "").strip()[:200]
        color = cuerpo.get("color")
        if not isinstance(pgn, str) or not pgn.strip() or not nombre or color not in ("w", "b", "auto"):
            return self._error(400, "faltan nombre, color o pgn")
        meta = {
            "id": uuid.uuid4().hex[:12],
            "nombre": nombre,
            "color": color,
            "creado": datetime.now().isoformat(timespec="seconds"),
            "catalogo": cuerpo.get("catalogo") if isinstance(cuerpo.get("catalogo"), dict) else None,
            "archivos": [str(a)[:200] for a in cuerpo.get("archivos") or []][:50],
        }
        with bloqueo:
            CURSOS_DIR.mkdir(parents=True, exist_ok=True)
            escribir_atomico(CURSOS_DIR / f"{meta['id']}.pgn", pgn)
            lista = cursos()
            lista.append(meta)
            escribir_json(CURSOS_JSON, lista)
        log(f"curso nuevo: {nombre} ({meta['id']})")
        return self._json(meta, 201)

    def _editar_curso(self, cid: str, cuerpo: dict):
        with bloqueo:
            lista = cursos()
            meta = next((c for c in lista if c["id"] == cid), None)
            if meta is None:
                return self._error(404, "curso no encontrado")
            if isinstance(cuerpo.get("nombre"), str) and cuerpo["nombre"].strip():
                meta["nombre"] = cuerpo["nombre"].strip()[:200]
            if cuerpo.get("color") in ("w", "b", "auto"):
                meta["color"] = cuerpo["color"]
            escribir_json(CURSOS_JSON, lista)
        return self._json(meta)

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        vida.entra()
        try:
            self.wfile.write(f"retry: 2000\nevent: hola\ndata: {os.getpid()}\n\n".encode())
            self.wfile.flush()
            while not parar.wait(LATIDO):
                self.wfile.write(b": latido\n\n")
                self.wfile.flush()
        except OSError:  # la pestana se cerro (ConnectionAborted/Reset en Windows)
            pass
        finally:
            vida.sale()
            self.close_connection = True

    def _estatico(self, ruta: str):
        if ruta in ("", "/"):
            ruta = "/index.html"
        archivo = (STATIC / ruta.lstrip("/")).resolve()
        if not archivo.is_relative_to(STATIC) or not archivo.is_file():
            return self._error(404, "no encontrado")
        tipo = MIME.get(archivo.suffix.lower(), "application/octet-stream")
        return self._enviar(200, archivo.read_bytes(), tipo)


# ---------------------------------------------------------------- arranque


class Servidor(ThreadingHTTPServer):
    daemon_threads = True
    # En Windows SO_REUSEADDR deja que dos procesos escuchen en el mismo puerto y el
    # trafico se lo lleva el primero: hay que pedir el puerto en exclusiva.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def ya_corriendo(puerto: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{puerto}/api/ping", timeout=1.5) as r:
            return json.load(r).get("app") == APP
    except (OSError, ValueError):
        return False


def main() -> None:
    ap = argparse.ArgumentParser(description="Entrenador PGN con repeticion espaciada")
    ap.add_argument("--puerto", type=int, default=int(os.environ.get("ENTRENADOR_PUERTO", PUERTO_BASE)))
    ap.add_argument("--siempre", action="store_true", help="no apagarse al cerrar la pestana")
    ap.add_argument("--sin-navegador", action="store_true")
    args = ap.parse_args()

    DATA.mkdir(exist_ok=True)
    if sys.stdout is None or sys.stderr is None:  # lanzado con pyw: sin consola
        salida = open(DATA / "servidor.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = salida

    if ya_corriendo(args.puerto):
        log(f"ya estaba abierto en el puerto {args.puerto}; solo abro el navegador")
        if not args.sin_navegador:
            webbrowser.open(f"http://127.0.0.1:{args.puerto}/")
        return

    servidor = None
    for puerto in range(args.puerto, args.puerto + 10):
        try:
            Manejador.puerto = puerto
            servidor = Servidor(("127.0.0.1", puerto), Manejador)
            break
        except OSError:
            continue
    if servidor is None:
        log("no hay puerto libre")
        sys.exit(1)

    copia_de_arranque()
    url = f"http://127.0.0.1:{Manejador.puerto}/"
    log(f"Entrenador PGN en {url}" + (" (modo permanente)" if args.siempre else ""))
    if not args.siempre:
        threading.Thread(target=vida.vigilar, args=(servidor,), daemon=True).start()
    if not args.sin_navegador:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    try:
        servidor.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        parar.set()
        servidor.server_close()
        log("servidor detenido")


if __name__ == "__main__":
    main()
