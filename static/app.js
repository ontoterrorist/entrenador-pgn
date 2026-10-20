// Entrenador PGN: panel, cursos, sesiones de entrenamiento, errores, catalogo y ajustes.

import { construirCurso, clavesDeLineas, adivinarColor, nombreSugerido, textoLinea, numeroJugada, bloquesTexto, NAG_TEXTO, claveFen, claveTarjeta } from "./pgn.js";
import * as S from "./srs.js";
import { Tablero } from "./tablero.js";
import { sonar } from "./sonidos.js";
import { Chessground } from "./vendor/chessground.min.js";
import { hayServidor, apiNavegador } from "./almacen.js";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

const COLOR_TXT = { w: "Blancas", b: "Negras", auto: "El bando que mueve" };
const MODO_TXT = { aprender: "Aprender", repaso: "Repaso", practica: "Práctica", errores: "Errores", lectura: "Lectura" };
const MODO_CHIP = { aprender: "azul", repaso: "verde", practica: "", errores: "rojo", lectura: "azul" };
const NIVELES = {
  beginning: ["Principiante", 800, 1000],
  casual: ["Casual", 1000, 1400],
  intermediate: ["Intermedio", 1400, 1800],
  advanced: ["Avanzado", 1800, 2100],
  expert: ["Experto", 2000, 2400],
};
const PENDIENTE_LS = "entrenador-pgn:pendiente";

const EJEMPLO = `[Event "Ejemplo: 1.e4 e5 con blancas"]
[Orientation "white"]

{Curso de ejemplo para probar el entrenador. Tú llevas las blancas; las negras las mueve la app.}
1. e4 e5 2. Nf3 Nc6 (2... d6 {La Defensa Philidor: sólida pero pasiva.} 3. d4 exd4 4. Nxd4 Nf6 5. Nc3 Be7 6. Be2 O-O 7. O-O {Más espacio y desarrollo cómodo.}) 3. Bc4 {La Italiana: el alfil apunta a f7. [%cal Gc4f7]} Bc5 (3... Nf6 {Los Dos Caballos.} 4. d3 {Tranquilo y sólido: no entramos en complicaciones.} Be7 5. O-O O-O 6. Re1 d6 7. c3) 4. c3 {Prepara d4.} Nf6 5. d3 d6 6. O-O O-O 7. Re1 a6 8. Bb3 {Retira el alfil antes de que ...Na5 lo cambie.} Ba7 9. h3 {Evita ...Bg4.} *
`;

const app = {
  metas: [],
  textos: {},
  cursos: [],
  tarjetas: new Map(),
  P: S.progresoVacio(),
  rev: 0,
  catalogo: null,
  filtroCat: { q: "", tipo: "", color: "", nivel: "", gratis: false, orden: "rating" },
  sesion: null,
};
let tablero = null;
let catalogoPendiente = null; // curso del catalogo al que se vinculara el PGN que se suba
let modoNavegador = false; // sin server.py (GitHub Pages): cursos y progreso en IndexedDB, ver almacen.js

// ================================================================== servidor

// Rutas relativas ("estado", "cursos/<id>"...): asi la app tambien funciona bajo un subpath.
async function api(ruta, { metodo = "GET", cuerpo } = {}) {
  if (modoNavegador) return apiNavegador(ruta, metodo, cuerpo);
  const op = { method: metodo, headers: {} };
  if (metodo !== "GET") op.headers["X-Entrenador"] = "1";
  if (cuerpo !== undefined) {
    op.headers["Content-Type"] = "application/json";
    op.body = JSON.stringify(cuerpo);
  }
  const r = await fetch(`api/${ruta}`, op);
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(datos.error || `HTTP ${r.status}`), { status: r.status, datos });
  return datos;
}

// Guardado: el progreso entero se manda al servidor 300 ms despues del ultimo cambio.
// Si el servidor no responde, se guarda en localStorage y se recupera al volver.
let sucio = false;
let guardando = false;
let bloqueado = false;
let tGuardar = 0;

function guardar() {
  sucio = true;
  clearTimeout(tGuardar);
  tGuardar = setTimeout(() => {
    actualizarTitulo();
    volcar();
  }, 300);
}

function respaldoLocal() {
  try {
    localStorage.setItem(PENDIENTE_LS, JSON.stringify({ baseRev: app.rev, data: app.P }));
  } catch {
    /* sin almacenamiento local: nada que hacer */
  }
}

async function volcar() {
  if (!sucio || bloqueado) return;
  if (guardando) {
    tGuardar = setTimeout(volcar, 200);
    return;
  }
  guardando = true;
  sucio = false;
  try {
    const r = await api("progreso", { metodo: "POST", cuerpo: { baseRev: app.rev, data: app.P } });
    app.rev = r.rev;
    try {
      if (!sucio) localStorage.removeItem(PENDIENTE_LS);
    } catch {}
  } catch (e) {
    if (e.status === 409) {
      bloqueado = true;
      mostrarAviso("conflicto", "Otra pestaña del entrenador guardó cambios. Recarga esta para seguir sin pisarlos.", "Recargar", () => location.reload());
    } else {
      sucio = true;
      respaldoLocal();
      tGuardar = setTimeout(volcar, 4000);
    }
  } finally {
    guardando = false;
  }
}

window.addEventListener("pagehide", () => {
  if (sucio || guardando) respaldoLocal();
});

// Cada pestana mantiene un canal SSE abierto: el servidor se apaga cuando no queda ninguno.
function conectarVida() {
  const srv = $("#srv");
  let tCaida = 0;
  const es = new EventSource("api/vida");
  es.addEventListener("hola", () => {
    clearTimeout(tCaida);
    srv.textContent = "servidor activo";
    srv.className = "srv ok";
    ocultarAviso("servidor");
    if (sucio) guardar();
  });
  es.onerror = () => {
    srv.textContent = "reconectando…";
    srv.className = "srv mal";
    clearTimeout(tCaida);
    tCaida = setTimeout(() => {
      if (es.readyState !== EventSource.OPEN)
        mostrarAviso("servidor", "El servidor local se cerró. Vuelve a abrir <b>Entrenador PGN.bat</b>: lo que no se haya guardado queda en este navegador y se recupera solo.");
    }, 6000);
  };
}

async function cargar() {
  const est = await api("estado");
  app.metas = est.cursos;
  app.rev = est.progreso.rev;
  app.P = S.normalizar(est.progreso.data);
  try {
    const pend = JSON.parse(localStorage.getItem(PENDIENTE_LS) || "null");
    if (pend?.data && pend.baseRev === app.rev) {
      app.P = S.normalizar(pend.data);
      guardar();
      toast("Recuperé progreso que no se había llegado a guardar.");
    } else if (pend) localStorage.removeItem(PENDIENTE_LS);
  } catch {}
  const textos = await Promise.all(app.metas.map((m) => textoCurso(m.id)));
  app.metas.forEach((m, i) => (app.textos[m.id] = textos[i]));
  app.cursos = app.metas.map((m) => construirCurso(m, app.textos[m.id]));
  indexar();
}

async function textoCurso(id) {
  if (modoNavegador) return apiNavegador(`cursos/${id}.pgn`);
  const r = await fetch(`api/cursos/${id}.pgn`);
  return r.ok ? r.text() : "";
}

function indexar() {
  app.tarjetas = new Map();
  for (const c of app.cursos) for (const [k, t] of c.tarjetas) app.tarjetas.set(k, t);
}

const curso = (id) => app.cursos.find((c) => c.id === id);
function buscarLinea(key) {
  for (const c of app.cursos) for (const l of c.lineas) if (l.key === key) return l;
  return null;
}

// ================================================================== avisos

function toast(texto, ms = 3200) {
  const el = $("#toast");
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

function mostrarAviso(id, html, boton, accion) {
  const el = $("#aviso");
  el.dataset.id = id;
  el.innerHTML = `<span>${html}</span>${boton ? `<button class="btn" type="button">${esc(boton)}</button>` : ""}`;
  if (boton) $("button", el).onclick = accion;
  el.hidden = false;
}

function ocultarAviso(id) {
  const el = $("#aviso");
  if (el.dataset.id === id) el.hidden = true;
}

// ================================================================== sonido

// Efectos de 8 bits (ver sonidos.js). Solo suenan el fallo y el final de una linea:
// las jugadas van en silencio.
function sonido(tipo) {
  if (app.P.ajustes.sonido) sonar(tipo);
}

// ================================================================== rutas

function ruta() {
  return location.hash.replace(/^#/, "") || "/";
}

function render() {
  const r = ruta();
  if (r !== "/entrenar" && app.sesion) {
    cancelarRun();
    app.sesion = null;
  }
  for (const a of $$(".nav a")) a.classList.toggle("activo", a.dataset.nav === r || (a.dataset.nav === "/" && r.startsWith("/curso/")));
  const entrenando = r === "/entrenar";
  $("#entrenador").hidden = !entrenando;
  $("#vista").hidden = entrenando;
  actualizarTitulo();
  if (entrenando) {
    if (!app.sesion) location.hash = "#/";
    return;
  }
  window.scrollTo(0, 0);
  if (r === "/") vistaPanel();
  else if (r.startsWith("/curso/")) vistaCurso(r.slice(7));
  else if (r === "/errores") vistaErrores();
  else if (r === "/catalogo" && !modoNavegador) vistaCatalogo();
  else if (r === "/ajustes") vistaAjustes();
  else location.hash = "#/";
}

function actualizarTitulo() {
  const ahora = Date.now();
  let n = 0;
  for (const k of app.tarjetas.keys()) if (S.tocaRepasar(app.P.tarjetas[k], ahora)) n++;
  document.title = n ? `(${n}) Entrenador PGN` : "Entrenador PGN";
}

// ================================================================== panel

function htmlPronostico(pron) {
  const max = Math.max(1, ...pron);
  const iMax = pron.indexOf(Math.max(...pron));
  const cols = pron.map((n, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const corto = i === 0 ? "Hoy" : i === 1 ? "Mañana" : d.toLocaleDateString("es", { weekday: "short" }).replace(".", "");
    const largo = d.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
    const alto = n ? Math.max(3, (n / max) * 100) : 0;
    const etiq = i === 0 || (i === iMax && n > 0);
    return `<div class="pron-col${etiq ? " etiquetada" : ""}" title="${esc(largo)}: ${plural(n, "posición", "posiciones")}">
      <span class="pron-valor">${n}</span>
      <div class="pron-area"><div class="pron-barra${i === 0 ? " hoy" : ""}" style="height:${alto}%"></div></div>
      <span class="pron-dia">${esc(corto)}</span></div>`;
  });
  return `<div class="pron" role="img" aria-label="Posiciones a repasar en los próximos 7 días: ${pron.join(", ")}">${cols.join("")}</div>`;
}

function htmlCurso(c) {
  const r = S.resumenCurso(app.P, c);
  const pAprend = r.total ? (r.aprendidas / r.total) * 100 : 0;
  const pCons = r.total ? (r.consolidadas / r.total) * 100 : 0;
  return `<article class="caja curso">
    <div class="curso-cab">
      <span class="pieza-color ${c.meta.color}" title="Entrenas con: ${esc(COLOR_TXT[c.meta.color])}" style="margin-top:6px"></span>
      <div><h3><a href="#/curso/${c.id}">${esc(c.nombre)}</a></h3>
      <div class="sub">${plural(c.capitulos.length, "capítulo", "capítulos")} · ${plural(r.total, "línea", "líneas")} · ${plural(r.tarjetas, "posición", "posiciones")}</div></div>
    </div>
    <div class="progreso" title="${r.consolidadas} consolidadas, ${r.aprendidas} aprendidas de ${r.total}">
      <div style="width:${pCons}%"></div><div class="p-aprendidas" style="width:${pAprend - pCons}%"></div>
    </div>
    <div class="fila-datos">
      <span><span class="pieza-color" style="background:var(--acento);border:0"></span> <b>${r.consolidadas}</b> consolidadas</span>
      <span><span class="pieza-color" style="background:var(--azul);border:0"></span> <b>${r.aprendidas}</b>/${r.total} aprendidas</span>
      ${r.debiles ? `<span class="mal">${plural(r.debiles, "débil", "débiles")}</span>` : ""}
    </div>
    <div class="acciones">
      <button class="btn ${r.pendientes ? "primario" : ""}" data-acc="repasar" data-id="${c.id}" ${r.pendientes ? "" : "disabled"}>Repasar${r.pendientes ? ` (${r.pendientes})` : ""}</button>
      <button class="btn ${!r.pendientes && r.nuevas ? "primario" : ""}" data-acc="aprender" data-id="${c.id}" ${r.nuevas ? "" : "disabled"}>Aprender${r.nuevas ? ` (${r.nuevas} nuevas)` : ""}</button>
      <button class="btn peligro" data-acc="reiniciar" data-id="${c.id}" title="Deja el curso como nuevo: olvida lo aprendido, los niveles, los errores y los textos leídos. El curso se conserva.">Eliminar progreso</button>
      ${r.debiles ? `<button class="btn" data-acc="errores" data-id="${c.id}">Errores (${r.debiles})</button>` : ""}
    </div>
  </article>`;
}

function vistaPanel() {
  const P = app.P;
  const ahora = Date.now();
  const vista = $("#vista");
  if (!app.cursos.length) {
    vista.innerHTML = `
      <div class="vacio">
        <div class="grande" aria-hidden="true">♞</div>
        <h1>Sube un PGN y empieza a entrenar</h1>
        <p>Cada partida del PGN es un capítulo y cada variante, una línea. La app juega las jugadas del rival y te pregunta las tuyas; lo que fallas vuelve antes, lo que aciertas se espacia (4 h, 1 día, 3 días, 1 semana…).</p>
        <p class="tenue">Arrastra aquí tus archivos .pgn, o usa los botones. Sirve cualquier PGN con variantes: un estudio de Lichess, una base de ChessBase, tu repertorio.</p>
        <div class="acciones">
          <button class="btn primario" data-acc="subir">Subir PGN</button>
          <button class="btn" data-acc="pegar">Pegar PGN</button>
          <button class="btn" data-acc="ejemplo">Probar con un ejemplo</button>
          ${modoNavegador ? `<button class="btn fantasma" data-acc="importar-progreso" title="Una copia exportada desde Ajustes, por ejemplo de la versión local">Importar una copia</button>` : `<a class="btn fantasma" href="#/catalogo">Ver catálogo de Chessable</a>`}
        </div>
      </div>`;
    return;
  }
  const pendientes = S.lineasPendientes(P, app.cursos, ahora);
  let posPend = 0;
  for (const k of app.tarjetas.keys()) if (S.tocaRepasar(P.tarjetas[k], ahora)) posPend++;
  const debiles = S.tarjetasDebiles(P, app.cursos).length;
  const nuevas = app.cursos.reduce((n, c) => n + S.lineasNuevas(P, c).length, 0);
  const hoy = P.dias[S.hoyClave(ahora)] || { rep: 0, ok: 0, nuevas: 0, lineas: 0 };
  const acierto = hoy.rep ? Math.round((100 * hoy.ok) / hoy.rep) : null;
  const racha = S.racha(P, ahora);
  let proxima = Infinity;
  for (const k of app.tarjetas.keys()) {
    const t = P.tarjetas[k];
    if (t && t.nv > 0 && t.vence > ahora) proxima = Math.min(proxima, t.vence);
  }

  vista.innerHTML = `
    <section class="resumen">
      <div class="caja">
        <span class="etiqueta">Para repasar ahora</span>
        <div class="cifra">${posPend}</div>
        <div class="sub">${posPend ? `posiciones en ${plural(pendientes.length, "línea", "líneas")}` : proxima < Infinity ? `nada pendiente · lo siguiente vence en ${S.textoIntervalo(proxima - ahora)}` : "nada pendiente todavía"}</div>
        ${htmlPronostico(S.pronostico(P, app.cursos, 7, ahora))}
        <div class="acciones">
          <button class="btn primario" data-acc="repasar-todo" ${pendientes.length ? "" : "disabled"}>Repasar todo</button>
          ${nuevas ? `<button class="btn" data-acc="aprender-todo">Aprender (${nuevas} nuevas)</button>` : ""}
        </div>
      </div>
      <div class="caja">
        <span class="etiqueta">Puntos débiles</span>
        <div class="cifra ${debiles ? "mal" : ""}">${debiles}</div>
        <div class="sub">${debiles ? "posiciones que has fallado y aún no has vuelto a acertar dos veces" : "ninguna posición fallada pendiente"}</div>
        <div class="acciones">
          <button class="btn" data-acc="errores-todo" ${debiles ? "" : "disabled"}>Practicar errores</button>
          <a class="btn fantasma" href="#/errores">Historial</a>
        </div>
      </div>
      <div class="caja">
        <span class="etiqueta">Hoy</span>
        <div class="cifra">${hoy.rep}</div>
        <div class="sub">jugadas repasadas${acierto !== null ? ` · ${acierto}% a la primera` : ""}</div>
        <div class="fila-datos" style="margin-top:auto">
          <span><b>${hoy.lineas}</b> líneas nuevas</span>
          <span>Racha: <b>${plural(racha, "día", "días")}</b></span>
        </div>
      </div>
    </section>

    <section class="seccion">
      <div class="seccion-cab">
        <h2>Tus cursos</h2>
        <div class="derecha">
          <button class="btn primario" data-acc="subir">Subir PGN</button>
          <button class="btn" data-acc="pegar">Pegar PGN</button>
        </div>
      </div>
      <div class="cursos">${app.cursos.map(htmlCurso).join("")}</div>
      <p class="sub" style="margin-top:12px">También puedes arrastrar archivos .pgn a cualquier parte de la ventana.</p>
    </section>`;
}

// ================================================================== curso

function htmlCapitulo(cap) {
  let aprendidas = 0,
    pendientes = 0;
  for (const l of cap.lineas) {
    const e = S.estadoLinea(app.P, l);
    if (e.aprendida) aprendidas++;
    if (e.pendiente) pendientes++;
  }
  const nuevas = cap.lineas.length - aprendidas;
  return `<details class="capitulo" data-cap="${cap.i}">
    <summary>
      <span class="pieza-color ${cap.color}" title="Entrenas con ${esc(COLOR_TXT[cap.color])}"></span>
      <h3>${esc(cap.nombre)}</h3>
      <span class="sub">${plural(cap.lineas.length, "línea", "líneas")}</span>
      <span class="derecha">
        ${pendientes ? `<span class="chip ambar">${pendientes} pendientes</span>` : ""}
        ${nuevas ? `<span class="chip azul">${plural(nuevas, "nueva", "nuevas")}</span>` : `<span class="chip verde">aprendido</span>`}
      </span>
    </summary>
    <div class="lineas"></div>
  </details>`;
}

const chipLeida = (l) => (app.P.lecturas[l.key] ? `<span class="chip verde">leído</span>` : `<span class="chip azul">sin leer</span>`);

// Pagina de lectura (ver pgn.js): capitulo que solo trae texto, o con jugadas pero sin linea
// nueva para ti. Se lee aqui mismo; al aprender, las que no has leido salen antes de las lineas.
function htmlLectura(l) {
  const que = l.tipo === "texto" ? "texto" : "capítulo sin línea nueva";
  return `<details class="lectura" data-lec="${l.i}">
    <summary>
      <span aria-hidden="true">📖</span>
      <h3>${esc(l.nombre)}</h3>
      <span class="sub">${que} · ${plural(l.palabras, "palabra", "palabras")}</span>
      <span class="derecha">${chipLeida(l)}</span>
    </summary>
    <div class="texto"></div>
  </details>`;
}

function marcarLeida(l) {
  if (app.P.lecturas[l.key]) return false;
  app.P.lecturas[l.key] = Date.now();
  guardar();
  return true;
}

// Lo que se lee de una pagina: el texto, o la partida (rama principal y variantes) con sus comentarios.
function htmlPagina(l) {
  return l.tipo === "texto" ? htmlBloques(bloquesTexto(l.crudo)) : htmlArbol(l.raiz);
}

function htmlArbol(raiz) {
  const partes = [];
  let seg = [];
  let numerar = true; // una jugada de negras lleva "5..." al empezar, tras un comentario o tras "("
  const vaciar = () => {
    if (seg.length) partes.push(`<p class="pgn-jug">${seg.join(" ")}</p>`);
    seg = [];
  };
  const com = (t) => {
    if (!t) return;
    vaciar();
    partes.push(`<div class="pgn-com">${t.split(/\n\n/).map((p) => `<p>${enlazar(p)}</p>`).join("")}</div>`);
    numerar = true;
  };
  const jugada = (n) => {
    com(n.pre);
    const num = n.padre.fen.split(" ")[5];
    if (n.color === "w") seg.push(`<span class="n">${num}.</span>`);
    else if (numerar) seg.push(`<span class="n">${num}...</span>`);
    numerar = false;
    seg.push(`<span class="j">${esc(n.san + n.nags.map((x) => NAG_TEXTO[x] || "").join(""))}</span>`);
    com(n.comentario);
  };
  // Continuacion principal de `padre` y, tras cada jugada, las alternativas entre parentesis.
  const rama = (padre) => {
    for (let p = padre; p.hijos.length; p = p.hijos[0]) {
      const [principal, ...alternativas] = p.hijos;
      jugada(principal);
      for (const alt of alternativas) {
        seg.push("(");
        numerar = true;
        jugada(alt);
        rama(alt);
        seg.push(")");
        numerar = true;
      }
    }
  };
  com(raiz.comentario);
  rama(raiz);
  vaciar();
  return partes.join("");
}

// Capitulos de entrenamiento y textos de lectura, en el orden del libro.
function htmlCapitulos(c) {
  const out = [];
  let k = 0;
  for (const cap of c.capitulos) {
    while (k < c.lecturas.length && c.lecturas[k].orden <= cap.orden) out.push(htmlLectura(c.lecturas[k++]));
    out.push(htmlCapitulo(cap));
  }
  while (k < c.lecturas.length) out.push(htmlLectura(c.lecturas[k++]));
  return out.join("");
}

function htmlLineas(cap) {
  const ahora = Date.now();
  return cap.lineas
    .map((l) => {
      const e = S.estadoLinea(app.P, l, ahora);
      const chip = !e.aprendida
        ? `<span class="chip azul">nueva</span>`
        : e.pendiente
          ? `<span class="chip ambar">pendiente</span>`
          : `<span class="chip verde" title="Nivel más bajo de sus posiciones">nivel ${e.nivel} · en ${S.textoIntervalo(e.proxima - ahora)}</span>`;
      const jug = textoLinea(l.nodos);
      return `<div class="linea">
        <div><div class="nom">${esc(l.etiqueta)}</div><div class="jug" title="${esc(jug)}">${esc(jug)}</div></div>
        <div class="estado">${chip}</div>
        <div><button class="btn chico" data-acc="linea" data-id="${l.key}">${e.aprendida ? "Practicar" : "Aprender"}</button></div>
      </div>`;
    })
    .join("");
}

function vistaCurso(id) {
  const c = curso(id);
  const vista = $("#vista");
  if (!c) {
    vista.innerHTML = `<a class="volver" href="#/">← Panel</a><p>Ese curso ya no existe.</p>`;
    return;
  }
  const r = S.resumenCurso(app.P, c);
  const cat = c.meta.catalogo;
  vista.innerHTML = `
    <a class="volver" href="#/">← Panel</a>
    <div class="curso-top">
      <input class="nombre" type="text" value="${esc(c.nombre)}" data-campo="nombre" aria-label="Nombre del curso" maxlength="200" />
      <label class="campo">Entrenas con
        <select data-campo="color">
          ${["w", "b", "auto"].map((v) => `<option value="${v}" ${c.meta.color === v ? "selected" : ""}>${COLOR_TXT[v]}${v === "auto" ? " (ejercicios)" : ""}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="fila-datos" style="margin-top:8px">
      <span><b>${r.aprendidas}</b>/${r.total} líneas aprendidas</span>
      <span><b>${r.consolidadas}</b> consolidadas (nivel ${S.NIVEL_CONSOLIDADA}+)</span>
      <span><b>${r.tarjetas}</b> posiciones</span>
      ${c.lecturas.length ? `<span><b>${c.lecturas.length}</b> ${c.lecturas.length === 1 ? "página" : "páginas"} de texto (${c.lecturas.filter((l) => !app.P.lecturas[l.key]).length} sin leer)</span>` : ""}
      ${r.debiles ? `<span class="mal">${r.debiles} débiles</span>` : ""}
      ${cat ? `<a href="${esc(cat.link)}" target="_blank" rel="noopener noreferrer">Ficha en Chessable ↗</a>` : ""}
    </div>
    ${c.avisos.length ? `<div class="avisos">${c.avisos.map(esc).join("<br>")}</div>` : ""}
    <div class="seccion-cab" style="margin-top:18px">
      <button class="btn ${r.pendientes ? "primario" : ""}" data-acc="repasar" data-id="${c.id}" ${r.pendientes ? "" : "disabled"}>Repasar${r.pendientes ? ` (${r.pendientes})` : ""}</button>
      <button class="btn ${!r.pendientes && r.nuevas ? "primario" : ""}" data-acc="aprender" data-id="${c.id}" ${r.nuevas ? "" : "disabled"}>Aprender ${Math.min(r.nuevas, app.P.ajustes.lineasNuevas) || ""} ${r.nuevas ? `de ${r.nuevas} nuevas` : ""}</button>
      <button class="btn" data-acc="errores" data-id="${c.id}" ${r.debiles ? "" : "disabled"}>Errores${r.debiles ? ` (${r.debiles})` : ""}</button>
      <div class="derecha">
        <button class="btn peligro" data-acc="reiniciar" data-id="${c.id}" title="Deja el curso como nuevo: olvida lo aprendido, los niveles, los errores y los textos leídos. El curso se conserva.">Eliminar progreso</button>
        <button class="btn peligro" data-acc="borrar" data-id="${c.id}">Eliminar curso</button>
      </div>
    </div>
    <div id="caps">${htmlCapitulos(c)}</div>`;

  for (const d of $$("details.capitulo", vista))
    d.addEventListener("toggle", () => {
      const cont = $(".lineas", d);
      if (d.open && !cont.childElementCount) cont.innerHTML = htmlLineas(c.capitulos[+d.dataset.cap]);
    });
  if (c.capitulos.length === 1) $("details.capitulo", vista).open = true;

  for (const d of $$("details.lectura", vista))
    d.addEventListener("toggle", () => {
      const cont = $(".texto", d);
      if (!d.open) return;
      const l = c.lecturas[+d.dataset.lec];
      if (!cont.childElementCount) {
        cont.innerHTML = htmlPagina(l);
        pintarDiagramas(cont);
      }
      if (marcarLeida(l)) $(".derecha", d).innerHTML = chipLeida(l);
    });

  $('[data-campo="nombre"]', vista).addEventListener("change", async (e) => {
    const nombre = e.target.value.trim();
    if (!nombre) return (e.target.value = c.nombre);
    try {
      const meta = await api(`cursos/${c.id}`, { metodo: "POST", cuerpo: { nombre } });
      Object.assign(c.meta, meta);
      c.nombre = meta.nombre;
      toast("Nombre guardado");
    } catch (err) {
      toast(`No se pudo renombrar: ${err.message}`);
    }
  });
  $('[data-campo="color"]', vista).addEventListener("change", async (e) => {
    const color = e.target.value;
    if (!confirm(`¿Entrenar este curso con ${COLOR_TXT[color].toLowerCase()}? Las líneas del otro bando se guardan por si vuelves.`)) {
      e.target.value = c.meta.color;
      return;
    }
    try {
      const meta = await api(`cursos/${c.id}`, { metodo: "POST", cuerpo: { color } });
      const nuevo = construirCurso(meta, app.textos[c.id]);
      app.cursos[app.cursos.indexOf(c)] = nuevo;
      app.metas = app.metas.map((m) => (m.id === meta.id ? meta : m));
      indexar();
      render();
    } catch (err) {
      toast(`No se pudo cambiar: ${err.message}`);
    }
  });
}

// Deja un curso como nuevo sin quitarlo: olvida lineas aprendidas, niveles, errores y textos
// leidos. Las estadisticas por dia (racha, repasos de hoy) no son de un curso y se conservan.
async function reiniciarProgreso(id) {
  const c = curso(id);
  if (!c) return;
  const pref = id + "|";
  const posiciones = Object.keys(app.P.tarjetas).filter((k) => k.startsWith(pref)).length;
  const textos = Object.keys(app.P.lecturas).filter((k) => k.startsWith(pref)).length;
  const errores = app.P.errores.filter((e) => e.k.startsWith(pref)).length;
  const lineas = S.resumenCurso(app.P, c).aprendidas;
  if (!posiciones && !textos && !errores && !lineas) return toast("Este curso todavía no tiene progreso.");
  const que = [lineas && plural(lineas, "línea aprendida", "líneas aprendidas"), posiciones && plural(posiciones, "posición con su nivel", "posiciones con su nivel"), errores && plural(errores, "fallo registrado", "fallos registrados"), textos && plural(textos, "texto leído", "textos leídos")].filter(Boolean).join(", ");
  if (!confirm(`¿Eliminar el progreso de «${c.nombre}»?\n\nSe olvida: ${que}.\n\nEl curso y su PGN se conservan y todo vuelve a estar como nuevo. No se puede deshacer.`)) return;
  toast("Eliminando progreso…", 60000);
  await new Promise((r) => setTimeout(r, 30)); // deja pintar el aviso antes del calculo
  for (const k of clavesDeLineas(c.meta, app.textos[id])) delete app.P.lineas[k];
  S.borrarCurso(app.P, id);
  guardar();
  toast("Progreso eliminado: el curso vuelve a estar como nuevo.");
  render();
}

async function borrarCurso(id) {
  const c = curso(id);
  if (!c || !confirm(`¿Eliminar «${c.nombre}» y su progreso? ${modoNavegador ? "El PGN se borra de este navegador." : "El PGN se mueve a data/papelera."}`)) return;
  try {
    await api(`cursos/${id}`, { metodo: "DELETE" });
  } catch (err) {
    return toast(`No se pudo eliminar: ${err.message}`);
  }
  for (const k of clavesDeLineas(c.meta, app.textos[id])) delete app.P.lineas[k];
  S.borrarCurso(app.P, id);
  guardar();
  app.cursos = app.cursos.filter((x) => x.id !== id);
  app.metas = app.metas.filter((m) => m.id !== id);
  delete app.textos[id];
  indexar();
  toast("Curso eliminado");
  location.hash = "#/";
}

// ================================================================== texto del PGN

// Enlaza las URL; el resto del texto va escapado.
function enlazar(txt) {
  return esc(txt).replace(/https?:\/\/[^\s<]+/g, (u) => {
    const cola = u.match(/[.,;:!?)\]]+$/)?.[0] || "";
    const url = u.slice(0, u.length - cola.length);
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${cola}`;
  });
}

function htmlBloques(bloques) {
  return bloques
    .map((b) => {
      if (b.t === "h") return `<h3>${enlazar(b.texto)}</h3>`;
      if (b.t === "cita") return `<blockquote>${enlazar(b.texto)}</blockquote>`;
      if (b.t === "fen") return `<div class="diagrama" data-fen="${esc(b.fen)}"></div>`;
      return `<p>${enlazar(b.texto)}</p>`;
    })
    .join("");
}

function pintarDiagramas(el) {
  for (const d of $$(".diagrama", el)) {
    try {
      Chessground(d, { fen: d.dataset.fen, orientation: d.dataset.ori === "black" ? "black" : "white", viewOnly: true, coordinates: false, animation: { enabled: false } });
    } catch {
      d.remove();
    }
  }
}

/**
 * El PGN de la linea en curso, en el panel y junto al tablero: texto del capitulo y las
 * jugadas con sus comentarios. Por defecto es la linea entera (lo que aun no has jugado,
 * atenuado) y entonces sustituye a la caja de comentario; con "Ocultar el resto" llega solo
 * hasta la jugada actual y lo que ya esta en la caja no se repite.
 */
function pintarPgn() {
  const r = app.sesion?.run;
  const el = $("#ent-pgn");
  const entero = !!app.P.ajustes.pgnCompleto;
  $("#ent-ver-pgn").textContent = entero ? "Ocultar el resto" : "Ver PGN completo";
  if (!r) {
    el.hidden = true;
    return;
  }
  const panel = $("#entrenador"); // la clase .pgn-entero va en la seccion: oculta la caja de comentario
  if (r.tipo === "pagina") {
    el.hidden = true; // una pagina de texto tiene su propio contenedor (#ent-texto)
    return;
  }
  const linea = r.tipo === "linea" ? r.linea : r.tarjeta.lineas[0];
  if (!linea || !(verComentarios(r) || entero)) {
    el.hidden = true;
    panel.classList.remove("pgn-entero");
    $("#ent-jugadas").hidden = false;
    return;
  }
  const cap = linea.capitulo;
  const enCaja = entero || $("#ent-comentario").hidden ? "" : $("#ent-comentario").textContent;
  const jugadas = r.tipo === "linea" ? r.j : 0;
  const hasta = entero ? linea.nodos.length : jugadas;
  const partes = [];
  let seg = [];
  const com = (t) => {
    if (!t || t === enCaja) return;
    partes.push(`<div class="pgn-com">${t.split(/\n\n/).map((p) => `<p>${enlazar(p)}</p>`).join("")}</div>`);
  };
  const vaciar = () => {
    if (seg.length) partes.push(`<p class="pgn-jug">${seg.join(" ")}</p>`);
    seg = [];
  };
  com(cap.raiz.comentario);
  let numerar = true; // una jugada de negras lleva "5..." al empezar o tras un comentario
  linea.nodos.slice(0, hasta).forEach((n, i) => {
    if (n.pre) {
      vaciar();
      com(n.pre);
      numerar = true;
    }
    const num = n.padre.fen.split(" ")[5];
    if (n.color === "w") seg.push(`<span class="n">${num}.</span>`);
    else if (numerar) seg.push(`<span class="n">${num}...</span>`);
    numerar = false;
    const tuya = n.color === linea.color;
    const cls = ["j", tuya && "tuya", tuya && r.marcas?.[i], i >= jugadas && "futura", i === jugadas - 1 && "ult"].filter(Boolean).join(" ");
    seg.push(`<span class="${cls}">${esc(n.san + n.nags.map((x) => NAG_TEXTO[x] || "").join(""))}</span>`);
    if (n.comentario) {
      vaciar();
      com(n.comentario);
      numerar = true;
    }
  });
  vaciar();
  const hay = partes.length > 0;
  const scroll = el.scrollTop; // cada jugada repinta el texto: no lo mandes arriba
  el.hidden = !hay;
  el.innerHTML = partes.join("");
  el.scrollTop = scroll;
  panel.classList.toggle("pgn-entero", hay && entero);
  // Con las jugadas ya dentro del texto, la lista compacta sobra. En errores se queda: lleva el contador de fallos.
  $("#ent-jugadas").hidden = hay && r.tipo === "linea";
}

// ================================================================== importar PGN

async function leerArchivos(lista) {
  const out = [];
  for (const f of lista) {
    if (!/\.(pgn|txt)$/i.test(f.name)) {
      toast(`${f.name} no parece un PGN; lo salto.`);
      continue;
    }
    const buf = await f.arrayBuffer();
    let texto;
    try {
      texto = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      texto = new TextDecoder("windows-1252").decode(buf); // ChessBase suele exportar en Latin-1
    }
    out.push({ nombre: f.name.replace(/\.(pgn|txt)$/i, ""), texto, tam: f.size });
  }
  return out;
}

function abrirImportar({ archivos = [], pegar = false, texto = "", catalogo = null } = {}) {
  const modal = $("#modal");
  const caja = $(".modal-caja", modal);
  const st = { unir: false, texto, borradores: [] };

  const armar = () => {
    let fuentes;
    if (pegar) fuentes = [{ nombre: catalogo?.titulo || st.borradores[0]?.nombre || nombreSugerido(st.texto), texto: st.texto, archivos: [] }];
    else if (st.unir) fuentes = [{ nombre: catalogo?.titulo || archivos[0].nombre, texto: archivos.map((a) => a.texto).join("\n\n"), archivos: archivos.map((a) => a.nombre) }];
    else fuentes = archivos.map((a, i) => ({ nombre: (archivos.length === 1 && catalogo?.titulo) || a.nombre, texto: a.texto, archivos: [a.nombre] }));
    st.borradores = fuentes.map((f) => {
      const colorCat = catalogo && catalogo.color !== "ambos" ? catalogo.color : null;
      return { ...f, color: colorCat || adivinarColor(f.texto, f.nombre), previa: null };
    });
    st.borradores.forEach(calcularPrevia);
  };
  const calcularPrevia = (b) => {
    b.previa = b.texto.trim() ? construirCurso({ id: "previa000000", nombre: b.nombre, color: b.color }, b.texto) : null;
  };
  const textoPrevia = (b) => {
    const p = b.previa;
    if (!p) return pegar ? "Pega un PGN para ver qué sale." : "Archivo vacío.";
    if (!p.lineas.length) return "No encontré líneas con jugadas de ese bando. Prueba con el otro color o revisa el PGN.";
    return `${plural(p.capitulos.length, "capítulo", "capítulos")} · ${plural(p.lineas.length, "línea", "líneas")} · ${plural(p.tarjetas.size, "posición", "posiciones")} para entrenar${p.lecturas.length ? ` · ${plural(p.lecturas.length, "texto", "textos")} para leer` : ""}${p.avisos.length ? ` · ⚠ ${p.avisos.join(" ")}` : ""}`;
  };
  const pintarBorradores = () => {
    $("#imp-borradores", caja).innerHTML = st.borradores
      .map(
        (b, i) => `<div class="borrador" data-b="${i}">
          <label class="campo">Nombre del curso<input type="text" data-campo="nombre" value="${esc(b.nombre)}" maxlength="200" placeholder="p. ej. Repertorio Najdorf" /></label>
          <label class="campo">Entrenas con<select data-campo="color">${["w", "b", "auto"].map((v) => `<option value="${v}" ${b.color === v ? "selected" : ""}>${COLOR_TXT[v]}${v === "auto" ? " (ejercicios)" : ""}</option>`).join("")}</select></label>
          <div class="previa ${b.previa?.lineas.length ? "" : "mal"}">${esc(textoPrevia(b))}</div>
        </div>`,
      )
      .join("");
    const validos = st.borradores.filter((b) => b.previa?.lineas.length && b.nombre.trim()).length;
    const btn = $('[data-imp="crear"]', caja);
    btn.disabled = !validos;
    btn.textContent = validos > 1 ? `Crear ${validos} cursos` : "Crear curso";
  };

  caja.innerHTML = `
    <h2>Nuevo curso desde PGN</h2>
    <p class="sub">Cada partida del PGN es un capítulo y cada variante, una línea. Tú juegas las jugadas de tu bando; la app mueve las del rival. Las flechas <code>[%cal]</code> y los comentarios del PGN se muestran al aprender.</p>
    ${catalogo ? `<div><span class="chip azul">Vinculado a: ${esc(catalogo.titulo)}</span></div>` : ""}
    ${pegar ? `<textarea id="imp-texto" placeholder="[Event &quot;Mi repertorio&quot;]&#10;&#10;1. e4 e5 2. Nf3 (2. Bc4) Nc6 3. Bb5 *" spellcheck="false"></textarea>` : ""}
    ${!pegar && archivos.length > 1 ? `<div class="opciones"><label><input type="radio" name="unir" value="0" checked /> Un curso por archivo</label><label><input type="radio" name="unir" value="1" /> Unir los ${archivos.length} archivos en un curso</label></div>` : ""}
    <div id="imp-borradores" style="display:grid;gap:10px"></div>
    <div class="modal-pie">
      <button class="btn fantasma" type="button" data-imp="cancelar">Cancelar</button>
      <button class="btn primario" type="button" data-imp="crear" disabled>Crear curso</button>
    </div>`;

  armar();
  pintarBorradores();
  modal.hidden = false;

  const area = $("#imp-texto", caja);
  if (area) {
    area.value = st.texto;
    area.focus();
    let t = 0;
    area.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const nombre = st.borradores[0]?.nombre;
        st.texto = area.value;
        armar();
        if (nombre) st.borradores[0].nombre = nombre;
        pintarBorradores();
      }, 350);
    });
  }
  for (const r of $$('input[name="unir"]', caja))
    r.addEventListener("change", () => {
      st.unir = r.value === "1" && r.checked;
      armar();
      pintarBorradores();
    });
  $("#imp-borradores", caja).addEventListener("change", (e) => {
    const fila = e.target.closest("[data-b]");
    if (!fila) return;
    const b = st.borradores[+fila.dataset.b];
    if (e.target.dataset.campo === "color") {
      b.color = e.target.value;
      calcularPrevia(b);
    } else b.nombre = e.target.value;
    pintarBorradores();
  });
  $("#imp-borradores", caja).addEventListener("input", (e) => {
    if (e.target.dataset.campo !== "nombre") return;
    st.borradores[+e.target.closest("[data-b]").dataset.b].nombre = e.target.value;
  });
  $('[data-imp="cancelar"]', caja).onclick = cerrarModal;
  $('[data-imp="crear"]', caja).onclick = async (e) => {
    e.target.disabled = true;
    const creados = [];
    for (const b of st.borradores) {
      if (!b.previa?.lineas.length || !b.nombre.trim()) continue;
      try {
        const meta = await api("cursos", {
          metodo: "POST",
          cuerpo: { nombre: b.nombre.trim(), color: b.color, pgn: b.texto, archivos: b.archivos, catalogo: catalogo ? { link: catalogo.link, titulo: catalogo.titulo } : null },
        });
        app.metas.push(meta);
        app.textos[meta.id] = b.texto;
        app.cursos.push(construirCurso(meta, b.texto));
        creados.push(meta);
      } catch (err) {
        toast(`No se pudo crear «${b.nombre}»: ${err.message}`, 6000);
      }
    }
    indexar();
    cerrarModal();
    if (!creados.length) return;
    toast(creados.length === 1 ? `Curso creado: ${creados[0].nombre}` : `${creados.length} cursos creados`);
    const destino = creados.length === 1 ? `#/curso/${creados[0].id}` : "#/";
    if (location.hash === destino) render();
    else location.hash = destino;
  };
}

function cerrarModal() {
  $("#modal").hidden = true;
  $("#modal .modal-caja").innerHTML = "";
}

// ================================================================== sesiones

function iniciarSesion(modo, items, cursos) {
  if (!items.length) return toast("Nada que entrenar aquí ahora mismo.");
  cancelarRun();
  const volver = ruta() === "/entrenar" ? app.sesion?.volver || "#/" : location.hash || "#/";
  app.sesion = { modo, items, cursos, i: -1, aciertos: 0, fallos: 0, limpias: 0, conFallo: 0, falladas: new Map(), volver };
  $("#vista").hidden = true;
  $("#entrenador").hidden = false;
  tablero ||= new Tablero($("#tablero"), { alMover });
  aplicarCoordenadas();
  aplicarOpciones();
  if (ruta() !== "/entrenar") location.hash = "#/entrenar";
  siguiente();
}

const sesionRepaso = (cursos) => iniciarSesion("repaso", S.lineasPendientes(app.P, cursos).slice(0, app.P.ajustes.lineasRepaso), cursos);
// Lineas nuevas (hasta el limite de la sesion) con, delante de cada una, las paginas de texto
// que aun no has leido y van antes en el libro. Si no quedan lineas nuevas, el resto del texto.
function itemsAprender(cursos) {
  const max = app.P.ajustes.lineasNuevas;
  const out = [];
  let lineas = 0;
  for (const c of cursos) {
    if (lineas >= max) break;
    const sinLeer = c.lecturas.filter((l) => !app.P.lecturas[l.key]);
    const nuevas = S.lineasNuevas(app.P, c);
    let k = 0;
    let tomadas = 0;
    for (const l of nuevas) {
      if (lineas >= max) break;
      while (k < sinLeer.length && sinLeer[k].orden <= l.capitulo.orden) out.push(sinLeer[k++]);
      out.push(l);
      lineas++;
      tomadas++;
    }
    if (tomadas === nuevas.length) out.push(...sinLeer.slice(k));
  }
  return out;
}

const sesionAprender = (cursos) => iniciarSesion("aprender", itemsAprender(cursos), cursos);
const sesionErrores = (cursos) =>
  iniciarSesion(
    "errores",
    S.tarjetasDebiles(app.P, cursos)
      .slice(0, app.P.ajustes.posicionesErrores)
      .map((x) => x.tarjeta),
    cursos,
  );

function cancelarRun() {
  const r = app.sesion?.run;
  if (r) clearTimeout(r.timer);
  pararReloj();
}

// ------------------------------------------------------------------ timer

// Cuenta atras en cada jugada tuya (aprender, repasar, practicar y errores). Los segundos los
// pones tu. Al agotarse avisa y, si lo pides, cuenta como fallo (se anula con "Fue un desliz").
const reloj = { id: 0, fin: 0, total: 1 };

function pintarReloj() {
  const resto = Math.max(0, reloj.fin - Date.now());
  const s = Math.ceil(resto / 1000);
  $("#ent-reloj-txt").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  $("#ent-reloj-prog").style.width = `${(resto / reloj.total) * 100}%`;
  $("#ent-reloj").classList.toggle("poco", resto > 0 && resto <= Math.min(5000, reloj.total / 3));
  $("#ent-reloj").classList.toggle("agotado", resto === 0);
}

function pararReloj() {
  clearInterval(reloj.id);
  reloj.id = 0;
  $("#ent-reloj").hidden = true;
}

function iniciarReloj() {
  pararReloj();
  const r = app.sesion?.run;
  if (!app.P.ajustes.timer || !r || r.terminado || r.tipo === "pagina") return;
  reloj.total = Math.max(1, Number(app.P.ajustes.timerSeg) || 30) * 1000;
  reloj.fin = Date.now() + reloj.total;
  $("#ent-reloj").hidden = false;
  pintarReloj();
  reloj.id = setInterval(() => {
    pintarReloj();
    if (Date.now() < reloj.fin) return;
    clearInterval(reloj.id);
    reloj.id = 0;
    agotarReloj();
  }, 200);
}

// Arranca (o reinicia) el reloj si ahora es tu turno de jugar.
function relojSiToca() {
  const r = app.sesion?.run;
  if (!r || r.terminado || r.tipo === "pagina") return;
  if (r.tipo === "linea" && esperado(r).color !== r.linea.color) return; // mueve el rival
  iniciarReloj();
}

function agotarReloj() {
  const s = app.sesion;
  const r = s?.run;
  if (!r || r.terminado || r.tipo === "pagina") return;
  if (app.P.ajustes.timerFallo && r.modo !== "aprender" && !r.fallada) {
    r.fallada = true;
    r.fallosLinea++;
    s.fallos++;
    const clave = claveDe(r);
    const foto = S.calificar(app.P, clave, false, { modo: r.modo, jugada: "(tiempo)", contexto: r.tipo === "linea" ? { l: r.linea.key } : {} });
    r.foto = { foto, j: idx(r), clave };
    s.falladas.set(clave, app.tarjetas.get(clave));
    guardar();
    sonido("error");
    sacudir();
    $("#ent-desliz").hidden = false;
    msg("⏱ ¡Se acabó el tiempo! Cuenta como fallo; sigue cuando quieras.", "error");
  } else msg("⏱ ¡Se acabó el tiempo!", "aviso-a");
}

function aplicarCoordenadas() {
  $(".ent-tablero").classList.toggle("sin-coords", !app.P.ajustes.coordenadas);
}

// Los dos interruptores del panel son los mismos ajustes que hay en Ajustes.
function aplicarOpciones() {
  $("#ent-opt-jugada").checked = !!app.P.ajustes.mostrarJugada;
  $("#ent-opt-texto").checked = !!app.P.ajustes.comentariosEnRepaso;
  $("#ent-timer-on").checked = !!app.P.ajustes.timer;
  $("#ent-timer-seg").value = String(app.P.ajustes.timerSeg);
  $("#ent-timer-fallo").checked = !!app.P.ajustes.timerFallo;
  aplicarTamTablero();
}

// El tablero ocupa el espacio disponible por --escala; la columna del texto se queda el resto.
function aplicarTamTablero() {
  const pct = Math.max(40, Math.min(100, Number(app.P.ajustes.tamTablero) || 100));
  $("#entrenador").style.setProperty("--escala", String(pct / 100));
  $("#ent-tam").value = String(pct);
}

$("#ent-tam").addEventListener("input", (e) => {
  app.P.ajustes.tamTablero = Number(e.target.value);
  aplicarTamTablero();
  guardar();
});

const verComentarios = (r) => r.modo === "aprender" || app.P.ajustes.comentariosEnRepaso;
// Con la mejor jugada apagada no hay flecha ni texto con la respuesta; solo la pista (H).
const veJugada = () => app.P.ajustes.mostrarJugada;
const esperado = (r) => (r.tipo === "linea" ? r.linea.nodos[r.j] : r.tarjeta);
const fenAntes = (r) => (r.tipo === "linea" ? r.linea.nodos[r.j].padre.fen : r.tarjeta.fen);
const cursoDe = (r) => (r.tipo === "linea" ? r.linea.curso : r.tarjeta.curso);
const claveDe = (r) => (r.tipo === "linea" ? claveTarjeta(r.linea.curso.id, fenAntes(r), esperado(r).uci) : r.tarjeta.key);
const idx = (r) => (r.tipo === "linea" ? r.j : 0);
const flecha = (n, pincel = "green") => ({ orig: n.desde, dest: n.hasta, brush: pincel });
// Las flechas del PGN van en tono palido para no confundirlas con "la jugada que toca".
const PALIDO = { green: "paleGreen", red: "paleRed", blue: "paleBlue", yellow: "yellow" };
const palidas = (formas = []) => formas.map((f) => ({ ...f, brush: PALIDO[f.brush] || f.brush }));

// Contexto del PGN que se ve al aprender: el ultimo comentario y sus flechas. La jugada del
// rival sin comentario no lo borra, asi que la explicacion de tu jugada sigue a la vista.
function ponerContexto(r, n, { tuya }) {
  if (tuya) r.ctx = { texto: n.comentario || "", formas: n.formas || [] };
  else {
    if (n.comentario) r.ctx.texto = n.comentario;
    if (n.formas?.length) r.ctx.formas = n.formas;
  }
  comentario(r.ctx.texto);
}

// Quien juega en la posicion que se ve ("Juegan blancas"); con `tuyo`, si es tu bando o el rival.
function pintarTurno(color, tuyo = null) {
  const el = $("#ent-turno");
  const quien = tuyo === null ? "" : ` <span class="tenue">· ${tuyo ? "tú" : "rival"}</span>`;
  el.innerHTML = `<span class="pieza-color ${color}"></span> Juegan ${color === "w" ? "blancas" : "negras"}${quien}`;
  el.hidden = false;
}
const ocultarTurno = () => ($("#ent-turno").hidden = true);

function msg(html, tipo = "") {
  const el = $("#ent-msg");
  el.className = `msg ${tipo}`;
  el.innerHTML = html;
}
function comentario(txt) {
  const el = $("#ent-comentario");
  el.hidden = !txt;
  el.textContent = txt || "";
}
function botones(vis = {}) {
  for (const k of ["pista", "desliz", "prueba", "repetir", "atras", "siguiente"]) $(`#ent-${k}`).hidden = !vis[k];
}
function sacudir() {
  const el = $(".ent-tablero");
  el.classList.remove("error");
  void el.offsetWidth;
  el.classList.add("error");
}

function actualizarProgreso() {
  const s = app.sesion;
  const n = s.items.length;
  const hechos = Math.min(s.i + (s.run?.terminado ? 1 : 0), n);
  $("#ent-prog").textContent = `${Math.min(s.i + 1, n)} de ${n}`;
  $("#ent-barra").style.width = `${(hechos / n) * 100}%`;
}

function siguiente() {
  const s = app.sesion;
  if (!s) return;
  cancelarRun();
  if (s.run?.tipo === "pagina") marcarLeida(s.run.pagina);
  s.i++;
  // En repaso, una linea puede haber dejado de estar pendiente porque sus posiciones
  // ya se repasaron en otra linea de esta misma sesion.
  if (s.modo === "repaso") while (s.i < s.items.length && !S.estadoLinea(app.P, s.items[s.i]).pendiente) s.i++;
  if (s.i >= s.items.length) return finSesion();
  mostrarItem();
}

// Vuelve a la pagina de texto anterior. Solo entre paginas de lectura: una linea ya hecha
// no se repite desde aqui.
function retroceder() {
  const s = app.sesion;
  if (!s || s.run?.tipo !== "pagina" || !s.items[s.i - 1]?.pagina) return;
  cancelarRun();
  marcarLeida(s.run.pagina);
  s.i--;
  mostrarItem();
}

// Muestra el elemento actual de la sesion (pagina, linea o posicion).
function mostrarItem() {
  const s = app.sesion;
  $("#ent-fin").hidden = true;
  $("#ent-jugadas").hidden = false;
  $("#ent-texto").hidden = true;
  $(".ent-opciones").hidden = false;
  $("#ent-modo").textContent = MODO_TXT[s.modo];
  $("#ent-modo").className = `chip ${MODO_CHIP[s.modo]}`;
  const item = s.items[s.i];
  if (item.pagina) empezarPagina(item);
  else if (s.modo === "errores") empezarPosicion(item);
  else empezarLinea(item, s.modo);
  actualizarProgreso();
}

// ------------------------------------------------------------------ paginas de texto

// Un capitulo de texto: tablero en la posicion inicial del capitulo (la inicial, si solo trae
// texto) y todo el texto en el panel. Se sigue con "Siguiente" y se vuelve con "Atrás".
function empezarPagina(l) {
  const s = app.sesion;
  cancelarRun();
  s.run = { tipo: "pagina", pagina: l, modo: "lectura", terminado: true, fallada: false, foto: null, pistas: 0, fallosLinea: 0, timer: 0 };
  $("#ent-modo").textContent = MODO_TXT.lectura;
  $("#ent-modo").className = `chip ${MODO_CHIP.lectura}`;
  $("#ent-titulo").innerHTML = `<b>${esc(l.nombre)}</b>${esc(l.curso.nombre)}`;
  tablero.posicion(l.fen, { orientacion: l.tipo === "partida" ? l.color : "w" });
  tablero.activar(false);
  if (l.tipo === "partida") pintarTurno(l.color); // una posicion de la partida: dice quien juega
  else ocultarTurno(); // texto solo: tablero inicial, sin posicion que jugar
  comentario("");
  msg(l.tipo === "texto" ? "Texto del libro. Cuando termines, sigue." : "Este capítulo no te da una línea nueva: se lee.", "info");
  botones({ siguiente: true, atras: !!s.items[s.i - 1]?.pagina });
  const ultimo = s.i >= s.items.length - 1;
  $("#ent-siguiente").innerHTML = `${ultimo ? "Terminar" : "Siguiente"} <kbd>Enter</kbd>`;
  $("#ent-jugadas").hidden = true;
  $("#ent-pgn").hidden = true;
  $("#entrenador").classList.remove("pgn-entero");
  $(".ent-opciones").hidden = true;
  const cont = $("#ent-texto");
  cont.innerHTML = htmlPagina(l);
  cont.hidden = false;
  cont.scrollTop = 0;
  pintarDiagramas(cont);
}

// ------------------------------------------------------------------ lineas

function empezarLinea(linea, modo) {
  const s = app.sesion;
  cancelarRun();
  const cap = linea.capitulo;
  const r = (s.run = { tipo: "linea", linea, modo, j: 0, fallosLinea: 0, fallada: false, foto: null, pistas: 0, marcas: [], ultima: undefined, timer: 0, terminado: false, ctx: { texto: cap.raiz.comentario || "", formas: cap.raiz.formas || [] } });
  if (modo !== s.modo) {
    $("#ent-modo").textContent = MODO_TXT[modo];
    $("#ent-modo").className = `chip ${MODO_CHIP[modo]}`;
  }
  $("#ent-titulo").innerHTML = `<b>${esc(cap.nombre)}</b>${esc(linea.curso.nombre)} · ${esc(linea.etiqueta)}`;
  tablero.posicion(cap.raiz.fen, { orientacion: linea.color, formas: verComentarios(r) ? palidas(r.ctx.formas) : [] });
  comentario(verComentarios(r) ? r.ctx.texto : "");
  botones({ pista: true });
  pintarJugadas();
  avanzar();
}

function avanzar() {
  const s = app.sesion;
  const r = s?.run;
  if (!r || r.terminado) return;
  const nodos = r.linea.nodos;
  if (r.j >= nodos.length) return finLinea();
  const n = nodos[r.j];
  pintarTurno(n.color, n.color === r.linea.color);

  if (n.color !== r.linea.color) {
    tablero.activar(false);
    if (r.j === 0) msg(`Empiezan las ${n.color === "w" ? "blancas" : "negras"}…`);
    r.timer = setTimeout(
      () => {
        if (app.sesion !== s || s.run !== r) return;
        if (verComentarios(r)) ponerContexto(r, n, { tuya: false });
        tablero.jugar(n.uci, { formas: verComentarios(r) ? palidas(r.ctx.formas) : [] });
        r.ultima = [n.desde, n.hasta];
        r.j++;
        pintarJugadas();
        avanzar();
      },
      r.j === 0 ? 350 : app.P.ajustes.retardo,
    );
    return;
  }

  // Turno tuyo.
  r.fallada = false;
  r.ultimoFallo = null;
  r.pistas = 0;
  tablero.activar(true);
  turnoTuyo(r, n);
  iniciarReloj();
}

// Lo que se ve mientras esperas tu jugada. Se repinta al cambiar "Mostrar mejor jugada".
function turnoTuyo(r, n) {
  const previo = r.j > 0 ? r.linea.nodos[r.j - 1] : null;
  if (r.modo === "aprender") {
    if (veJugada()) {
      tablero.flechas([...palidas(r.ctx.formas), flecha(n)]);
      msg(`Juega <b>${esc(numeroJugada(n.padre.fen, n.color, n.san))}</b>${n.nags.length ? ` <span class="tenue">${esc(n.nags.map((x) => NAG_TEXTO[x] || "").join(""))}</span>` : ""}`, "info");
    } else {
      tablero.flechas(palidas(r.ctx.formas));
      msg(`Tu turno: encuentra la jugada. <span class="tenue">(<kbd>H</kbd> = pista)</span>`, "info");
    }
    if (n.pre) comentario(n.pre);
  } else {
    tablero.flechas([]);
    msg(previo ? `Tu turno tras <b>${esc(numeroJugada(previo.padre.fen, previo.color, previo.san))}</b>` : "Empiezas tú: ¿qué juegas?");
  }
}

function pintarJugadas() {
  listaJugadas();
  pintarPgn();
}

// Lista compacta de jugadas. Si el PGN esta en pantalla (ver pintarPgn), esta lista se oculta.
function listaJugadas() {
  const r = app.sesion?.run;
  const el = $("#ent-jugadas");
  if (!r) return (el.innerHTML = "");
  if (r.tipo === "posicion") {
    const t = app.P.tarjetas[r.tarjeta.key];
    el.innerHTML = `<span class="tenue" style="font-family:var(--fuente)">Fallada ${plural(t?.fallos || 0, "vez", "veces")} · nivel ${t?.nv || 0}</span>`;
    return;
  }
  const out = [];
  r.linea.nodos.slice(0, r.j).forEach((n, i) => {
    const num = n.padre.fen.split(" ")[5];
    if (n.color === "w") out.push(`<span class="n">${num}.</span>`);
    else if (i === 0) out.push(`<span class="n">${num}...</span>`);
    const tuya = n.color === r.linea.color;
    const cls = ["j", tuya && "tuya", tuya && r.marcas[i], i === r.j - 1 && "ult"].filter(Boolean).join(" ");
    const nag = n.nags.map((x) => NAG_TEXTO[x] || "").join("");
    out.push(`<span class="${cls}">${esc(n.san + nag)}</span>`);
  });
  el.innerHTML = out.join(" ");
}

function finLinea() {
  const s = app.sesion;
  const r = s.run;
  r.terminado = true;
  tablero.activar(false);
  ocultarTurno();
  if (r.modo === "aprender") S.aprenderLinea(app.P, r.linea);
  else if (!app.P.lineas[r.linea.key]) app.P.lineas[r.linea.key] = { aprendida: Date.now() };
  guardar();
  const limpia = r.fallosLinea === 0;
  if (limpia) s.limpias++;
  else s.conFallo++;
  sonido("fin");
  if (r.modo === "aprender") msg("✓ Línea aprendida. Te la volveré a preguntar en unas 4 horas.", "ok");
  else msg(limpia ? "✓ Línea completada sin fallos" : `Línea completada con ${plural(r.fallosLinea, "fallo", "fallos")}`, limpia ? "ok" : "aviso-a");
  const ultimo = s.i >= s.items.length - 1;
  $("#ent-siguiente").innerHTML = `${ultimo ? "Terminar" : "Siguiente"} <kbd>Enter</kbd>`;
  botones({ siguiente: true, repetir: r.modo !== "aprender", prueba: r.modo === "aprender", desliz: !!r.foto });
  actualizarProgreso();
  if (limpia && r.modo !== "aprender" && app.P.ajustes.avanceAuto)
    r.timer = setTimeout(() => {
      if (app.sesion === s && s.run === r) siguiente();
    }, 1100);
}

// ------------------------------------------------------------------ posiciones (errores)

function empezarPosicion(t) {
  const s = app.sesion;
  cancelarRun();
  s.run = { tipo: "posicion", tarjeta: t, modo: "errores", fallada: false, foto: null, pistas: 0, fallosLinea: 0, ultima: t.previo || undefined, timer: 0, terminado: false };
  $("#ent-titulo").innerHTML = `<b>${esc(t.capitulo.nombre)}</b>${esc(t.curso.nombre)}`;
  tablero.posicion(t.fen, { orientacion: t.color, ultima: t.previo || undefined, interactivo: true });
  pintarTurno(t.color, true);
  comentario("");
  msg(t.previoSan ? `Tras <b>${esc(t.previoSan)}</b>, ¿qué juegas?` : "Posición inicial del capítulo: ¿qué juegas?");
  botones({ pista: true });
  pintarJugadas();
  iniciarReloj();
}

function finPosicion() {
  const s = app.sesion;
  const r = s.run;
  r.terminado = true;
  tablero.activar(false);
  ocultarTurno();
  if (r.fallada) s.conFallo++;
  else s.limpias++;
  msg(r.fallada ? "Esa era. Volverá a salir hasta que la aciertes dos veces." : "✓ Correcto", r.fallada ? "aviso-a" : "ok");
  comentario(r.tarjeta.comentario || "");
  pintarJugadas();
  const ultimo = s.i >= s.items.length - 1;
  $("#ent-siguiente").innerHTML = `${ultimo ? "Terminar" : "Siguiente"} <kbd>Enter</kbd>`;
  botones({ siguiente: true, desliz: !!r.foto });
  actualizarProgreso();
  if (!r.fallada && app.P.ajustes.avanceAuto)
    r.timer = setTimeout(() => {
      if (app.sesion === s && s.run === r) siguiente();
    }, 900);
}

// ------------------------------------------------------------------ jugadas del alumno

function alMover(m) {
  const s = app.sesion;
  const r = s?.run;
  if (!r || r.terminado) return tablero.restaurar({ interactivo: false });
  const n = esperado(r);
  const uci = m.from + m.to + (m.promotion || "");
  if (r.foto && r.foto.j !== idx(r)) {
    r.foto = null; // el "desliz" solo vale para la ultima jugada fallada
    $("#ent-desliz").hidden = true;
  }
  if (uci === n.uci) return acierto(n);

  const otras = cursoDe(r).porPosicion.get(claveFen(fenAntes(r))) || [];
  if (otras.some((t) => t.uci === uci)) {
    msg("Esa jugada también es de tu repertorio, pero en esta línea se juega otra. Prueba de nuevo.", "info");
    return tablero.restaurar({ ultima: r.ultima });
  }
  if (r.modo === "aprender") {
    if (!veJugada()) {
      msg(`Esa no es. Prueba otra vez. <span class="tenue">(<kbd>H</kbd> = pista)</span>`, "info");
      return tablero.restaurar({ ultima: r.ultima, formas: palidas(r.ctx.formas) });
    }
    msg(`Juega la de la flecha: <b>${esc(numeroJugada(fenAntes(r), n.color, n.san))}</b>`, "info");
    return tablero.restaurar({ ultima: r.ultima, formas: [flecha(n)] });
  }
  fallo(n, m);
}

function acierto(n) {
  const s = app.sesion;
  const r = s.run;
  pararReloj();
  if (r.modo !== "aprender" && !r.fallada) {
    S.calificar(app.P, claveDe(r), true, { modo: r.modo });
    s.aciertos++;
    guardar();
  }
  if (r.tipo === "linea") r.marcas[r.j] = r.fallada ? "fallo" : "ok";
  const mostrar = verComentarios(r) || r.fallada;
  tablero.jugar(n.uci, { formas: mostrar ? palidas(n.formas) : [] });
  r.ultima = [n.desde, n.hasta];
  if (r.tipo === "posicion") return finPosicion();
  if (mostrar) ponerContexto(r, n, { tuya: true });
  else comentario("");
  if (r.modo === "aprender") msg("✓", "ok");
  else msg(r.fallada ? "Eso es. Sigue." : "✓ Correcto", r.fallada ? "" : "ok");
  r.j++;
  pintarJugadas();
  avanzar();
}

function fallo(n, m) {
  const s = app.sesion;
  const r = s.run;
  const san = tablero.san(m);
  const clave = claveDe(r);
  if (!r.fallada) {
    r.fallada = true;
    r.fallosLinea++;
    s.fallos++;
    const foto = S.calificar(app.P, clave, false, { modo: r.modo, jugada: san, contexto: r.tipo === "linea" ? { l: r.linea.key } : {} });
    r.foto = { foto, j: idx(r), clave };
    s.falladas.set(clave, app.tarjetas.get(clave));
    guardar();
  }
  sonido("error");
  sacudir();
  r.ultimoFallo = { san, desde: m.from, hasta: m.to };
  pintarFallo(r, n);
}

// El aviso de fallo. Se repinta al cambiar "Mostrar mejor jugada" con el fallo a la vista.
function pintarFallo(r, n) {
  const f = r.ultimoFallo;
  const roja = flecha({ desde: f.desde, hasta: f.hasta }, "red");
  if (veJugada()) {
    msg(`✗ <b>${esc(f.san)}</b> no es. Era <b>${esc(numeroJugada(fenAntes(r), n.color, n.san))}</b>: juégala para seguir.`, "error");
    comentario(n.comentario || "");
    tablero.restaurar({ ultima: r.ultima, formas: [flecha(n), roja] });
  } else {
    // Sin revelar la jugada: ni flecha ni el comentario, que suele nombrarla. Sale al acertarla.
    msg(`✗ <b>${esc(f.san)}</b> no es. Prueba otra vez. <span class="tenue">(<kbd>H</kbd> = pista)</span>`, "error");
    comentario("");
    tablero.restaurar({ ultima: r.ultima, formas: [roja] });
  }
  $("#ent-desliz").hidden = !r.foto;
}

function pista() {
  const s = app.sesion;
  const r = s?.run;
  if (!r || r.terminado) return;
  const n = esperado(r);
  if (r.tipo === "linea" && n.color !== r.linea.color) return; // mueve el rival
  if (r.modo === "aprender") return tablero.flechas([flecha(n)]);
  r.pistas++;
  if (!r.fallada) {
    r.fallada = true;
    r.fallosLinea++;
    s.fallos++;
    const clave = claveDe(r);
    S.calificar(app.P, clave, false, { modo: r.modo, jugada: "(pista)", contexto: r.tipo === "linea" ? { l: r.linea.key } : {} });
    s.falladas.set(clave, app.tarjetas.get(clave));
    guardar();
  }
  if (r.pistas === 1) {
    tablero.flechas([{ orig: n.desde, brush: "green" }]);
    msg("Pista: mueve la pieza marcada. (Una pista cuenta como fallo.)", "aviso-a");
  } else {
    tablero.flechas([flecha(n)]);
    msg(`La jugada es <b>${esc(numeroJugada(fenAntes(r), n.color, n.san))}</b>.`, "aviso-a");
  }
}

function desliz() {
  const s = app.sesion;
  const r = s?.run;
  if (!r?.foto) return;
  S.deshacer(app.P, r.foto.foto);
  s.fallos--;
  r.fallosLinea--;
  s.falladas.delete(r.foto.clave);
  const yaJugada = r.tipo === "linea" ? r.j > r.foto.j : r.terminado;
  if (yaJugada) {
    // Ya jugaste la buena: cuenta como acierto a la primera.
    S.calificar(app.P, r.foto.clave, true, { modo: r.modo });
    s.aciertos++;
    if (r.tipo === "linea") r.marcas[r.foto.j] = "ok";
    if (r.terminado && r.fallosLinea === 0) {
      s.conFallo--;
      s.limpias++;
    }
  } else r.fallada = false; // la proxima jugada buena contara como acierto
  r.foto = null;
  $("#ent-desliz").hidden = true;
  guardar();
  pintarJugadas();
  msg("Anotado como desliz: ese fallo no cuenta.", "info");
  if (!r.terminado) tablero.restaurar({ ultima: r.ultima, formas: [] });
}

function finSesion() {
  const s = app.sesion;
  cancelarRun();
  s.run = null;
  tablero.activar(false);
  tablero.flechas([]);
  botones({});
  comentario("");
  ocultarTurno();
  $("#ent-jugadas").hidden = true;
  $("#ent-texto").hidden = true;
  $(".ent-opciones").hidden = false;
  pintarPgn();
  $("#ent-prog").textContent = "";
  $("#ent-barra").style.width = "100%";
  $("#ent-titulo").innerHTML = "";
  const total = s.aciertos + s.fallos;
  const pct = total ? Math.round((100 * s.aciertos) / total) : null;
  msg(`Sesión terminada${pct !== null ? ` · ${pct}% a la primera` : ""}`, "ok");
  const quedan = S.lineasPendientes(app.P, s.cursos).length;
  const nuevas = s.cursos.reduce((a, c) => a + S.lineasNuevas(app.P, c).length, 0);
  const unidad = s.modo === "errores" ? ["posición", "posiciones"] : ["línea", "líneas"];
  const fin = $("#ent-fin");
  fin.hidden = false;
  fin.innerHTML = `
    <div class="cifras">
      <div class="caja"><div class="cifra chica">${s.limpias + s.conFallo}</div><div class="sub">${unidad[1]}</div></div>
      <div class="caja"><div class="cifra chica bien">${s.aciertos}</div><div class="sub">aciertos</div></div>
      <div class="caja"><div class="cifra chica mal">${s.fallos}</div><div class="sub">fallos</div></div>
    </div>
    ${s.falladas.size ? `<p class="sub">Fallaste ${plural(s.falladas.size, "posición", "posiciones")}. Repasarlas ahora ayuda a fijarlas; no adelanta su calendario.</p>` : ""}
    <div class="acciones">
      ${s.falladas.size ? `<button class="btn primario" data-fin="fallos">Repasar mis fallos ahora</button>` : ""}
      ${quedan ? `<button class="btn ${s.falladas.size ? "" : "primario"}" data-fin="repaso">Seguir repasando (${quedan})</button>` : ""}
      ${nuevas && s.modo !== "errores" ? `<button class="btn ${!quedan && !s.falladas.size ? "primario" : ""}" data-fin="aprender">Aprender más (${nuevas} nuevas)</button>` : ""}
      <button class="btn" data-fin="salir">Volver</button>
    </div>`;
  const primero = $(".btn.primario", fin) || $('[data-fin="salir"]', fin);
  primero?.focus();
}

$("#ent-fin").addEventListener("click", (e) => {
  const b = e.target.closest("[data-fin]");
  const s = app.sesion;
  if (!b || !s) return;
  const acc = b.dataset.fin;
  if (acc === "fallos") iniciarSesion("errores", [...s.falladas.values()].filter(Boolean), s.cursos);
  else if (acc === "repaso") sesionRepaso(s.cursos);
  else if (acc === "aprender") sesionAprender(s.cursos);
  else location.hash = s.volver;
});

$("#ent-salir").addEventListener("click", () => (location.hash = app.sesion?.volver || "#/"));
$("#ent-pista").addEventListener("click", pista);
$("#ent-desliz").addEventListener("click", desliz);
$("#ent-siguiente").addEventListener("click", siguiente);
$("#ent-atras").addEventListener("click", retroceder);
$("#ent-repetir").addEventListener("click", () => {
  const r = app.sesion?.run;
  if (r?.tipo === "linea") empezarLinea(r.linea, "practica");
});
$("#ent-prueba").addEventListener("click", () => {
  const r = app.sesion?.run;
  if (r?.tipo === "linea") empezarLinea(r.linea, "practica");
});

$("#ent-opt-jugada").addEventListener("change", (e) => {
  app.P.ajustes.mostrarJugada = e.target.checked;
  guardar();
  e.target.blur(); // para que H, Enter y Esc sigan funcionando
  const r = app.sesion?.run;
  if (r && !r.terminado) {
    const n = esperado(r);
    if (r.tipo === "linea" && n.color !== r.linea.color) {
      // mueve el rival: nada que repintar
    } else if (r.tipo === "linea" && (r.modo === "aprender" || !r.fallada)) turnoTuyo(r, n);
    // Fallo a la vista: se repinta con o sin la jugada (una pista en curso se deja como está).
    else if (r.fallada && r.ultimoFallo && !r.pistas) pintarFallo(r, n);
  }
  pintarPgn();
});

$("#ent-opt-texto").addEventListener("change", (e) => {
  app.P.ajustes.comentariosEnRepaso = e.target.checked;
  guardar();
  e.target.blur();
  const r = app.sesion?.run;
  // Con un fallo a medias se ve el comentario del fallo; en aprender los comentarios siempre salen.
  if (r && !r.terminado && r.tipo === "linea" && r.modo !== "aprender" && !r.fallada) {
    comentario(e.target.checked ? r.ctx.texto : "");
    tablero.flechas(e.target.checked ? palidas(r.ctx.formas) : []);
  }
  pintarPgn();
});

// Linea entera o solo hasta la jugada actual. Es un ajuste: se queda como lo dejes.
// Timer: activar/desactivar, segundos (se escriben o con las flechas) y si el tiempo cuenta como fallo.
$("#ent-timer-on").addEventListener("change", (e) => {
  app.P.ajustes.timer = e.target.checked;
  guardar();
  e.target.blur();
  if (e.target.checked) relojSiToca();
  else pararReloj();
});
$("#ent-timer-seg").addEventListener("change", (e) => {
  let v = Math.round(Number(e.target.value));
  if (!Number.isFinite(v) || v < 1) v = e.target.value === "" ? app.P.ajustes.timerSeg : 1;
  v = Math.min(3600, v);
  e.target.value = String(v);
  app.P.ajustes.timerSeg = v;
  guardar();
  if (reloj.id) relojSiToca(); // con el reloj en marcha, empieza de nuevo con el valor nuevo
});
$("#ent-timer-seg").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.target.blur();
});
$("#ent-timer-fallo").addEventListener("change", (e) => {
  app.P.ajustes.timerFallo = e.target.checked;
  guardar();
  e.target.blur();
});

$("#ent-ver-pgn").addEventListener("click", () => {
  app.P.ajustes.pgnCompleto = !app.P.ajustes.pgnCompleto;
  guardar();
  pintarPgn();
});

document.addEventListener("keydown", (e) => {
  if (!$("#modal").hidden) {
    if (e.key === "Escape") cerrarModal();
    return;
  }
  if (ruta() !== "/entrenar" || e.target.matches("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "escape") $("#ent-salir").click();
  else if (k === "h") pista();
  else if (k === "d" && !$("#ent-desliz").hidden) desliz();
  else if (k === "arrowleft" && !$("#ent-atras").hidden) retroceder();
  else if (k === "arrowright" && app.sesion?.run?.tipo === "pagina") siguiente(); // en una pagina de texto: ← y → van y vuelven
  else if ((k === "enter" || k === " ") && !$("#ent-siguiente").hidden) {
    e.preventDefault();
    siguiente();
  }
});

// ================================================================== errores

function fechaRel(t) {
  const d = Date.now() - t;
  if (d < 60e3) return "ahora";
  if (d < 3600e3) return `hace ${Math.round(d / 60e3)} min`;
  if (d < 86400e3) return `hace ${Math.round(d / 3600e3)} h`;
  return new Date(t).toLocaleDateString("es", { day: "numeric", month: "short", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function vistaErrores() {
  const P = app.P;
  const debiles = S.tarjetasDebiles(P, app.cursos);
  const ultimoError = new Map();
  for (const e of P.errores) ultimoError.set(e.k, e);
  const historial = P.errores
    .slice(-200)
    .reverse()
    .filter((e) => app.tarjetas.has(e.k));
  const n = Math.min(debiles.length, P.ajustes.posicionesErrores);
  $("#vista").innerHTML = `
    <div class="seccion-cab">
      <h1>Errores</h1>
      <div class="derecha">${debiles.length ? `<button class="btn primario" data-acc="errores-todo">${n === 1 ? "Practicar la posición débil" : `Practicar las ${n} más débiles`}</button>` : ""}</div>
    </div>
    <p class="sub">Cada fallo queda registrado. La posición vuelve al nivel 1 del calendario (repaso en 4 h) y suma debilidad; sale de esta lista cuando la aciertas dos veces, aquí o en un repaso normal.</p>

    <section class="seccion">
      <div class="seccion-cab"><h2>Posiciones débiles</h2><span class="chip ${debiles.length ? "rojo" : "verde"}">${debiles.length}</span></div>
      ${
        debiles.length
          ? `<div class="debiles">${debiles
              .slice(0, 24)
              .map(({ tarjeta: t, t: est }) => {
                const ult = ultimoError.get(t.key);
                return `<div class="caja debil">
                  <div class="mini" data-k="${esc(t.key)}"></div>
                  <div class="txt"><b>${esc(t.capitulo.nombre)}</b><br>${esc(t.curso.nombre)}<br>
                  ${t.previoSan ? `Tras ${esc(t.previoSan)}` : "Inicio del capítulo"}${ult?.jugada ? ` · jugaste <span class="mal">${esc(ult.jugada)}</span>` : ""}<br>
                  Fallada ${plural(est.fallos, "vez", "veces")}</div>
                  <button class="btn chico" data-acc="posicion" data-id="${esc(t.key)}">Practicar</button>
                </div>`;
              })
              .join("")}</div>${debiles.length > 24 ? `<p class="sub">Y ${debiles.length - 24} más.</p>` : ""}`
          : `<p class="tenue">Ninguna ahora mismo.</p>`
      }
    </section>

    <section class="seccion">
      <details class="plegable">
        <summary class="seccion-cab" style="cursor:pointer"><h2>Historial de fallos</h2><span class="sub">${plural(P.errores.length, "fallo registrado", "fallos registrados")} · muestra las respuestas</span></summary>
        ${
          historial.length
            ? `<div class="tabla-wrap"><table class="tabla">
            <thead><tr><th>Cuándo</th><th>Curso · capítulo</th><th>Posición</th><th>Jugaste</th><th>Correcta</th><th>Modo</th></tr></thead>
            <tbody>${historial
              .map((e) => {
                const t = app.tarjetas.get(e.k);
                return `<tr><td class="tenue">${esc(fechaRel(e.t))}</td><td>${esc(t.curso.nombre)} · ${esc(t.capitulo.nombre)}</td><td>${esc(t.previoSan ? `tras ${t.previoSan}` : "inicio")}</td><td class="mal">${esc(e.jugada || "—")}</td><td class="bien">${esc(t.san)}</td><td class="tenue">${esc(MODO_TXT[e.modo] || e.modo)}</td></tr>`;
              })
              .join("")}</tbody></table></div>`
            : `<p class="tenue">Sin fallos todavía.</p>`
        }
      </details>
    </section>`;
  for (const el of $$(".mini")) {
    const t = app.tarjetas.get(el.dataset.k);
    Chessground(el, {
      fen: t.fen,
      orientation: t.color === "w" ? "white" : "black",
      viewOnly: true,
      coordinates: false,
      lastMove: t.previo || undefined,
      animation: { enabled: false },
    });
  }
}

// ================================================================== catalogo

function rangoElo(niveles) {
  if (!niveles.length) return "—";
  const lo = Math.min(...niveles.map((n) => NIVELES[n][1]));
  const hi = Math.max(...niveles.map((n) => NIVELES[n][2]));
  return `${lo}–${hi}`;
}

async function vistaCatalogo() {
  const vista = $("#vista");
  if (!app.catalogo) {
    vista.innerHTML = `<p class="cargando">Cargando catálogo…</p>`;
    try {
      app.catalogo = await api("catalogo");
    } catch (e) {
      vista.innerHTML = `<p class="mal">No se pudo cargar el catálogo: ${esc(e.message)}</p>`;
      return;
    }
    if (ruta() !== "/catalogo") return;
  }
  const f = app.filtroCat;
  const tipos = [...new Set(app.catalogo.map((c) => c.tipo))].sort();
  vista.innerHTML = `
    <div class="seccion-cab"><h1>Catálogo de Chessable</h1><span class="chip">${app.catalogo.length} cursos · julio 2020</span></div>
    <p class="sub">Metadatos de <a href="https://github.com/ChessNomad/chessable-courses" target="_blank" rel="noopener noreferrer">ChessNomad/chessable-courses</a> (scrapeados el 30-07-2020; precios y valoraciones pueden haber cambiado). El repositorio no trae jugadas: úsalo para elegir qué estudiar y, si tienes el PGN de un curso, súbelo desde su fila para vincularlo.</p>
    <div class="filtros">
      <input type="search" data-f="q" placeholder="Buscar título o autor…" value="${esc(f.q)}" aria-label="Buscar" />
      <select data-f="tipo" aria-label="Tipo"><option value="">Todos los tipos</option>${tipos.map((t) => `<option ${f.tipo === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      <select data-f="color" aria-label="Bando">
        <option value="">Cualquier bando</option>
        <option value="w" ${f.color === "w" ? "selected" : ""}>Para blancas</option>
        <option value="b" ${f.color === "b" ? "selected" : ""}>Para negras</option>
        <option value="ambos" ${f.color === "ambos" ? "selected" : ""}>Ambos bandos</option>
      </select>
      <select data-f="nivel" aria-label="Nivel">
        <option value="">Cualquier nivel</option>
        ${Object.entries(NIVELES)
          .map(([k, [n, lo, hi]]) => `<option value="${k}" ${f.nivel === k ? "selected" : ""}>${n} (${lo}–${hi})</option>`)
          .join("")}
      </select>
      <label class="sub"><input type="checkbox" data-f="gratis" ${f.gratis ? "checked" : ""} /> Solo gratis</label>
      <select data-f="orden" aria-label="Ordenar">
        <option value="rating" ${f.orden === "rating" ? "selected" : ""}>Mejor valorados</option>
        <option value="votos" ${f.orden === "votos" ? "selected" : ""}>Más valoraciones</option>
        <option value="variantes" ${f.orden === "variantes" ? "selected" : ""}>Más variantes</option>
        <option value="fecha" ${f.orden === "fecha" ? "selected" : ""}>Más recientes</option>
        <option value="precio" ${f.orden === "precio" ? "selected" : ""}>Más baratos</option>
      </select>
    </div>
    <p class="sub" id="cat-cuenta"></p>
    <div class="tabla-wrap"><table class="tabla">
      <thead><tr><th>Curso</th><th>Tipo</th><th>Bando</th><th>Elo</th><th class="num">Valoración</th><th class="num">Variantes</th><th class="num">Prof.</th><th class="num">Precio</th><th>Publicado</th><th></th></tr></thead>
      <tbody id="cat-filas"></tbody>
    </table></div>`;
  for (const el of $$("[data-f]", vista)) {
    const ev = el.type === "search" ? "input" : "change";
    el.addEventListener(ev, () => {
      f[el.dataset.f] = el.type === "checkbox" ? el.checked : el.value;
      pintarCatalogo();
    });
  }
  pintarCatalogo();
}

function pintarCatalogo() {
  const f = app.filtroCat;
  const q = f.q.trim().toLowerCase();
  const vinculados = new Map(app.cursos.filter((c) => c.meta.catalogo).map((c) => [c.meta.catalogo.link, c]));
  // Media bayesiana: un 5,0 con 2 votos no debe ganar a un 4,8 con 300.
  const conNota = app.catalogo.filter((c) => c.rating != null && c.votos);
  const media = conNota.reduce((s, c) => s + c.rating * c.votos, 0) / Math.max(1, conNota.reduce((s, c) => s + c.votos, 0));
  const M = 25;
  const nota = (c) => (c.rating == null || !c.votos ? 0 : (c.rating * c.votos + media * M) / (c.votos + M));
  const filas = app.catalogo
    .filter(
      (c) =>
        (!q || c.titulo.toLowerCase().includes(q) || c.autor.toLowerCase().includes(q)) &&
        (!f.tipo || c.tipo === f.tipo) &&
        (!f.color || c.color === f.color) &&
        (!f.nivel || c.niveles.includes(f.nivel)) &&
        (!f.gratis || c.precio === 0),
    )
    .sort((a, b) => {
      if (f.orden === "rating") return nota(b) - nota(a);
      if (f.orden === "votos") return (b.votos ?? 0) - (a.votos ?? 0);
      if (f.orden === "variantes") return (b.variantes ?? 0) - (a.variantes ?? 0);
      if (f.orden === "fecha") return (b.fecha || "").localeCompare(a.fecha || "");
      return (a.precio ?? 1e9) - (b.precio ?? 1e9);
    });
  $("#cat-cuenta").textContent = `${plural(filas.length, "curso", "cursos")}`;
  $("#cat-filas").innerHTML = filas
    .map((c, i) => {
      const propio = vinculados.get(c.link);
      return `<tr>
        <td class="cat-titulo"><a href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">${esc(c.titulo)}</a><div class="sub">${esc(c.autor)}</div></td>
        <td>${esc(c.tipo)}</td>
        <td class="nw">${c.color === "ambos" ? "Ambos" : `<span class="pieza-color ${c.color}"></span> ${COLOR_TXT[c.color]}`}</td>
        <td class="tenue nw">${rangoElo(c.niveles)}</td>
        <td class="num">${c.rating != null ? `<span class="estrellas">★</span> ${c.rating.toFixed(1)} <span class="tenue">(${c.votos ?? 0})</span>` : "—"}</td>
        <td class="num">${c.variantes ?? "—"}</td>
        <td class="num">${c.profundidad != null ? c.profundidad.toFixed(1) : "—"}</td>
        <td class="num">${c.precio === 0 ? `<span class="bien">Gratis</span>` : c.precio != null ? `${c.precio.toFixed(2)} €` : "—"}</td>
        <td class="tenue" style="white-space:nowrap">${c.fecha ? esc(new Date(c.fecha).toLocaleDateString("es", { month: "short", year: "numeric" })) : "—"}</td>
        <td>${propio ? `<a class="btn chico" href="#/curso/${propio.id}">Abrir</a>` : `<button class="btn chico" data-acc="subir-cat" data-id="${app.catalogo.indexOf(c)}">Subir PGN</button>`}</td>
      </tr>`;
    })
    .join("");
}

// ================================================================== ajustes

function vistaAjustes() {
  const a = app.P.ajustes;
  const fila = (titulo, desc, control) => `<div class="ajuste"><div><div>${titulo}</div>${desc ? `<div class="desc">${desc}</div>` : ""}</div><div>${control}</div></div>`;
  const num = (k, min, max) => `<input type="number" data-aj="${k}" min="${min}" max="${max}" value="${a[k]}" style="width:84px" />`;
  const chk = (k) => `<input type="checkbox" data-aj="${k}" ${a[k] ? "checked" : ""} />`;
  $("#vista").innerHTML = `
    <h1>Ajustes</h1>
    <div class="caja ajustes" style="margin-top:16px">
      ${fila("Castigo por fallo", "Chessable devuelve la posición al nivel 1. En modo suave baja dos niveles (y la vuelves a ver en 4 h igualmente).", `<select data-aj="castigo"><option value="reinicio" ${a.castigo === "reinicio" ? "selected" : ""}>Volver al nivel 1</option><option value="suave" ${a.castigo === "suave" ? "selected" : ""}>Bajar 2 niveles</option></select>`)}
      ${fila("Líneas por sesión de repaso", "", num("lineasRepaso", 1, 500))}
      ${fila("Líneas nuevas por sesión de aprendizaje", "", num("lineasNuevas", 1, 100))}
      ${fila("Posiciones por práctica de errores", "", num("posicionesErrores", 1, 200))}
      ${fila("Pausa antes de la jugada del rival", `<span id="aj-retardo">${a.retardo} ms</span>`, `<input type="range" data-aj="retardo" min="0" max="1500" step="50" value="${a.retardo}" />`)}
      ${fila("Pasar sola a la siguiente línea", "Solo cuando la terminas sin fallos.", chk("avanceAuto"))}
      ${fila("Mostrar la mejor jugada", "Flecha y texto con la jugada correcta al aprender y tras un fallo. Apagado, tienes que encontrarla tú (la pista, <kbd>H</kbd>, sigue disponible). También está en el panel de entrenamiento.", chk("mostrarJugada"))}
      ${fila("Texto del PGN durante el repaso", "Los comentarios del PGN se ven mientras juegas, también en repaso. Apagado: en repaso solo ves el comentario de la jugada que fallas. También está en el panel de entrenamiento.", chk("comentariosEnRepaso"))}
      ${fila("Línea completa del PGN en el panel", "El panel muestra la línea entera con sus comentarios desde el principio (lo que aún no has jugado, atenuado). Apagado: solo llega hasta la jugada actual. También es el botón «Ocultar el resto» / «Ver PGN completo» del panel.", chk("pgnCompleto"))}
      ${fila("Sonido", "Efectos de 8 bits al estilo Game Boy, solo al fallar y al terminar una línea. Las jugadas van en silencio.", `<span style="display:inline-flex;gap:10px;align-items:center"><button class="btn chico" type="button" data-acc="probar-sonidos">▶ Escuchar</button>${chk("sonido")}</span>`)}
      ${fila("Coordenadas en el tablero", "", chk("coordenadas"))}
      ${fila("Timer por jugada", "Cuenta atrás en cada jugada tuya al entrenar. También está en el panel de entrenamiento.", chk("timer"))}
      ${fila("Segundos por jugada", "El tiempo del timer: escribe el número.", num("timerSeg", 1, 3600))}
      ${fila("Fallo al agotarse el tiempo", "Si el timer llega a cero sin que juegues, la posición cuenta como fallo (en repaso, práctica y errores). «Fue un desliz» lo anula.", chk("timerFallo"))}
      ${fila("Tamaño del tablero", `<span id="aj-tam">${a.tamTablero} %</span> del espacio disponible. El texto usa el que sobra. También hay un control en el panel de entrenamiento.`, `<input type="range" data-aj="tamTablero" min="40" max="100" step="5" value="${a.tamTablero}" />`)}
    </div>

    <section class="seccion">
      <h2>Calendario de repaso</h2>
      <p class="sub">Intervalo tras acertar una posición que tocaba repasar, según el nivel al que sube:</p>
      <div class="intervalos">${S.INTERVALOS.slice(1)
        .map((ms, i) => `<span class="chip ${i + 1 >= S.NIVEL_CONSOLIDADA ? "verde" : ""}">N${i + 1} · ${S.textoIntervalo(ms)}</span>`)
        .join("")}</div>
    </section>

    <section class="seccion">
      <h2>Tus datos</h2>
      ${
        modoNavegador
          ? `<p class="sub">Todo se guarda <b>solo en este navegador</b>: si borras los datos del sitio o cambias de navegador o de equipo, no estarán allí. Exporta una copia completa de vez en cuando; con «Importar» la cargas aquí, en otro navegador o en la versión local (<code>server.py</code>).</p>`
          : `<p class="sub">Todo se guarda en <code>ajedrez/entrenador-pgn/data/</code>: <code>progreso.json</code> (repasos y fallos) y <code>cursos/</code> (tus PGN). Cada arranque deja una copia del progreso en <code>data/copias/</code>. La copia completa sirve para llevarte cursos y progreso a la versión web.</p>`
      }
      <div class="seccion-cab">
        <button class="btn" data-acc="exportar-todo" title="Cursos (con sus PGN) y progreso en un solo archivo">Exportar copia completa</button>
        <button class="btn" data-acc="exportar" title="Solo repasos, fallos y ajustes: un archivo pequeño">Exportar solo progreso</button>
        <button class="btn" data-acc="importar-progreso" title="Acepta los dos tipos de archivo">Importar</button>
      </div>
    </section>`;
  for (const el of $$("[data-aj]")) {
    el.addEventListener(el.type === "range" ? "input" : "change", () => {
      const k = el.dataset.aj;
      let v = el.type === "checkbox" ? el.checked : el.type === "number" || el.type === "range" ? Number(el.value) : el.value;
      if (typeof v === "number") v = Math.max(Number(el.min), Math.min(Number(el.max), Math.round(v) || Number(el.min)));
      app.P.ajustes[k] = v;
      if (k === "retardo") $("#aj-retardo").textContent = `${v} ms`;
      if (k === "tamTablero") $("#aj-tam").textContent = `${v} %`;
      guardar();
    });
  }
}

// La copia completa lleva ademas el texto de cada PGN: con ella se pasa todo de la version
// local a la web (o a otro navegador), donde cada uno guarda sus datos aparte.
function exportar(completa = false) {
  const datos = { app: "entrenador-pgn", exportado: new Date().toISOString(), cursos: app.metas, progreso: app.P };
  if (completa) datos.pgn = app.textos;
  const url = URL.createObjectURL(new Blob([JSON.stringify(datos, null, completa ? 0 : 1)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `entrenador-pgn-${completa ? "copia" : "progreso"}-${S.hoyClave()}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Los cursos conservan su id (las claves del progreso lo llevan delante); los que ya estan
// aqui se dejan como estan. El progreso se reemplaza entero por el del archivo.
async function importarCursos(datos) {
  const ids = new Set(app.metas.map((m) => m.id));
  const nuevos = (datos.cursos || []).filter((m) => typeof datos.pgn[m.id] === "string" && !ids.has(m.id));
  const repetidos = (datos.cursos || []).length - nuevos.length;
  const aviso = modoNavegador ? "" : "\n\n(Queda una copia del progreso actual en data/copias al reiniciar.)";
  if (!confirm(`¿Importar la copia?\n\nSe añaden ${plural(nuevos.length, "curso", "cursos")}${repetidos ? ` (${repetidos} ya estaban y se dejan como están)` : ""} y tu progreso se reemplaza por el del archivo.${aviso}`)) return false;
  toast("Importando…", 60000);
  for (const m of nuevos) {
    const texto = datos.pgn[m.id];
    const meta = await api("cursos", { metodo: "POST", cuerpo: { id: m.id, nombre: m.nombre, color: m.color, pgn: texto, archivos: m.archivos, catalogo: m.catalogo } });
    app.metas.push(meta);
    app.textos[meta.id] = texto;
    app.cursos.push(construirCurso(meta, texto));
  }
  indexar();
  return true;
}

$("#archivo-progreso").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const datos = JSON.parse(await f.text());
    const prog = datos.progreso || datos;
    if (!prog.tarjetas) throw new Error("no parece un progreso del entrenador");
    if (datos.pgn) {
      if (!(await importarCursos(datos))) return;
    } else if (!confirm(`¿Reemplazar tu progreso actual por el del archivo?${modoNavegador ? "" : " (Queda una copia del actual en data/copias al reiniciar.)"}`)) return;
    app.P = S.normalizar(prog);
    guardar();
    toast("Progreso importado");
    render();
  } catch (err) {
    toast(`No se pudo importar: ${err.message}`);
  }
});

// ================================================================== acciones y arranque

const acciones = {
  subir: () => $("#archivo").click(),
  pegar: () => abrirImportar({ pegar: true }),
  ejemplo: () => abrirImportar({ pegar: true, texto: EJEMPLO }),
  "repasar-todo": () => sesionRepaso(app.cursos),
  "aprender-todo": () => sesionAprender(app.cursos),
  "errores-todo": () => sesionErrores(app.cursos),
  repasar: (id) => sesionRepaso([curso(id)]),
  aprender: (id) => sesionAprender([curso(id)]),
  errores: (id) => sesionErrores([curso(id)]),
  borrar: (id) => borrarCurso(id),
  reiniciar: (id) => reiniciarProgreso(id),
  linea: (key) => {
    const l = buscarLinea(key);
    if (l) iniciarSesion(app.P.lineas[l.key] ? "practica" : "aprender", [l], [l.curso]);
  },
  posicion: (key) => {
    const t = app.tarjetas.get(key);
    if (t) iniciarSesion("errores", [t], [t.curso]);
  },
  "subir-cat": (i) => {
    catalogoPendiente = app.catalogo[+i];
    $("#archivo").click();
  },
  exportar: () => exportar(),
  "exportar-todo": () => exportar(true),
  "importar-progreso": () => $("#archivo-progreso").click(),
  "probar-sonidos": () => {
    // Suena aunque el sonido este apagado, para poder oirlo antes de activarlo.
    sonar("error");
    setTimeout(() => sonar("fin"), 700);
  },
};

$("#vista").addEventListener("click", (e) => {
  const b = e.target.closest("[data-acc]");
  if (b && !b.disabled) acciones[b.dataset.acc]?.(b.dataset.id);
});

$("#archivo").addEventListener("change", async (e) => {
  const archivos = await leerArchivos(e.target.files);
  e.target.value = "";
  const catalogo = catalogoPendiente;
  catalogoPendiente = null;
  if (archivos.length) abrirImportar({ archivos, catalogo });
});

$("#modal").addEventListener("mousedown", (e) => {
  if (e.target.id === "modal") cerrarModal();
});

// Arrastrar y soltar PGN en cualquier parte de la ventana.
let arrastres = 0;
const conArchivos = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!conArchivos(e)) return;
  arrastres++;
  $("#soltar").hidden = false;
});
window.addEventListener("dragleave", (e) => {
  if (!conArchivos(e)) return;
  if (--arrastres <= 0) {
    arrastres = 0;
    $("#soltar").hidden = true;
  }
});
window.addEventListener("dragover", (e) => {
  if (conArchivos(e)) e.preventDefault();
});
window.addEventListener("drop", async (e) => {
  if (!conArchivos(e)) return;
  e.preventDefault();
  arrastres = 0;
  $("#soltar").hidden = true;
  const archivos = await leerArchivos(e.dataTransfer.files);
  if (archivos.length) abrirImportar({ archivos });
});

window.addEventListener("hashchange", render);

// La pestana queda abierta todo el dia: refresca contadores cada minuto.
setInterval(() => {
  actualizarTitulo();
  if (ruta() === "/" && $("#modal").hidden) vistaPanel();
}, 60e3);

(async function arrancar() {
  modoNavegador = !(await hayServidor());
  if (modoNavegador) {
    // Sitio estatico: sin servidor que vigilar ni catalogo (sus datos no tienen licencia para publicarse).
    Object.assign($("#srv"), { textContent: "en este navegador", className: "srv ok", title: "Sin servidor: cursos y progreso se guardan en este navegador. Exporta una copia desde Ajustes." });
    $('.nav a[data-nav="/catalogo"]').hidden = true;
  } else conectarVida();
  try {
    await cargar();
  } catch (e) {
    $("#vista").innerHTML = `<p class="mal">No pude cargar los datos${modoNavegador ? " de este navegador" : " del servidor"}: ${esc(e.message)}</p>`;
    return;
  }
  if (ruta() === "/entrenar") location.hash = "#/";
  render();
})();
