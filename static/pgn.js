// PGN -> arbol de variantes -> lineas entrenables.
//
// Un curso es un PGN con una o varias partidas (capitulos). Cada partida se lee como un
// arbol (las variantes entre parentesis son ramas) y cada camino raiz->hoja es una linea,
// igual que en el MoveTrainer de Chessable. Cada jugada del bando que entrenas es una
// "tarjeta": posicion + jugada correcta. Dos lineas que pasan por la misma posicion con la
// misma jugada comparten tarjeta, asi que una transposicion no se repasa dos veces.

import { Chess } from "./vendor/chess.min.js";

export const FEN_INICIAL = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const NAG_TEXTO = { 1: "!", 2: "?", 3: "!!", 4: "??", 5: "!?", 6: "?!", 10: "=", 13: "∞", 14: "⩲", 15: "⩱", 16: "±", 17: "∓", 18: "+−", 19: "−+" };
const SUFIJO_NAG = { "!": 1, "?": 2, "!!": 3, "??": 4, "!?": 5, "?!": 6 };
const PINCEL = { G: "green", R: "red", Y: "yellow", B: "blue" };
// SAN, y tambien notacion larga ("Ng1-f3", "e2e4") que algunos exportadores escriben.
const SAN_OK = /^(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=?[QRBN])?|[KQRBN]?[a-h][1-8][x-]?[a-h][1-8](?:=?[QRBN])?|O-O(?:-O)?)[+#]?$/;

// Clave de posicion: tablero, turno, enroques y al paso (sin relojes de jugadas).
export const claveFen = (fen) => fen.split(" ").slice(0, 4).join(" ");
export const claveTarjeta = (cursoId, fen, uci) => `${cursoId}|${claveFen(fen)}|${uci}`;

// ------------------------------------------------------------------ lectura

const TOKEN =
  /\{([^}]*)\}|;([^\n]*)|\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]|(\()|(\))|\$(\d+)|(\d+)\s*\.+|(1-0|0-1|1\/2-1\/2|½-½|\*)|([!?]{1,2})|(--|Z0)|([A-Za-z0-9][A-Za-z0-9=+#-]*)([!?]{1,2})?|\S/g;

function partidaVacia() {
  return { cabeceras: {}, raiz: { hijos: [], comentario: "", padre: null }, tieneJugadas: false, terminada: false };
}

/**
 * Parte el texto PGN en partidas con su arbol de jugadas en SAN (sin validar aun).
 * Con `conTexto`, conserva tambien las que no traen jugadas pero si texto (prologos,
 * introducciones): en el PGN de un libro de Chessable son capitulos que solo se leen.
 */
export function leerPartidas(texto, { conTexto = false } = {}) {
  texto = texto.replace(/^﻿/, "").replace(/^%.*$/gm, "");
  const partidas = [];
  let p = null;
  let cur = null;
  let pila = [];
  let preComentario = "";
  let recienAbierta = false;
  let nulo = 0; // >0: dentro de una variante con jugada nula; se ignora hasta cerrarla

  const nueva = () => {
    p = partidaVacia();
    partidas.push(p);
    cur = p.raiz;
    pila = [];
    preComentario = "";
    nulo = 0;
  };

  for (const m of texto.matchAll(TOKEN)) {
    const [, com1, com2, tag, valor, abre, cierra, nag, numero, resultado, sufijo, nula, san, sufijoSan] = m;
    const esTag = tag !== undefined;
    if (esTag) {
      if (!p || p.tieneJugadas || p.terminada) nueva();
      p.cabeceras[tag] = valor.replace(/\\(.)/g, "$1");
      continue;
    }
    if (resultado) {
      if (p && pila.length === 0) p.terminada = true;
      continue;
    }
    if (numero !== undefined) continue;
    if (!p || p.terminada) {
      // Movetext sin cabeceras o tras un resultado: otra partida.
      if (com1 === undefined && com2 === undefined && !san) continue;
      nueva();
    }

    if (abre) {
      pila.push({ cur, nulo });
      if (cur.padre) cur = cur.padre;
      recienAbierta = true;
      continue;
    }
    if (cierra) {
      const tope = pila.pop();
      if (tope) ({ cur, nulo } = tope);
      recienAbierta = false;
      preComentario = "";
      continue;
    }
    // Tras una jugada nula las jugadas no se pueden leer, pero el texto si: se pega al ultimo
    // nodo valido (o al capitulo). Asi no se pierde el texto de los capitulos "1. -- *".
    const comentario = com1 ?? com2;
    if (nulo && comentario === undefined) continue;
    if (comentario !== undefined) {
      if (!nulo && (recienAbierta || (cur === p.raiz && p.raiz.hijos.length > 0))) preComentario += " " + comentario;
      else if (cur === p.raiz) p.raiz.comentario += " " + comentario;
      else cur.comentario += " " + comentario;
      continue;
    }
    if (nag) {
      if (cur !== p.raiz) cur.nags.push(+nag);
      continue;
    }
    if (sufijo) {
      if (cur !== p.raiz && SUFIJO_NAG[sufijo]) cur.nags.push(SUFIJO_NAG[sufijo]);
      continue;
    }
    if (nula) {
      nulo = 1;
      continue;
    }
    if (san) {
      const limpio = san
        .replace(/^0-0-0/, "O-O-O")
        .replace(/^0-0/, "O-O")
        .replace(/[+#]+$/, "")
        .replace(/([a-h][1-8])([QRBN])$/, "$1=$2");
      if (/^\d+$/.test(san) || !SAN_OK.test(limpio)) continue;
      const nodo = { san: limpio, padre: cur, hijos: [], comentario: "", pre: preComentario.trim(), nags: [] };
      if (sufijoSan && SUFIJO_NAG[sufijoSan]) nodo.nags.push(SUFIJO_NAG[sufijoSan]);
      cur.hijos.push(nodo);
      cur = nodo;
      p.tieneJugadas = true;
      preComentario = "";
      recienAbierta = false;
    }
  }
  return partidas.filter((x) => x.tieneJugadas || (conTexto && x.raiz.comentario.trim()));
}

// ------------------------------------------------------------------ texto

// Las exportaciones de Chessable marcan la estructura del texto con @@...@@: titulos,
// citas, notas entre corchetes, enlaces y diagramas (@@StartFEN@@fen@@EndFEN@@).
const BLOQUE = /@@HeaderStart@@(.*?)@@HeaderEnd@@|@@StartBlockQuote@@(.*?)@@EndBlockQuote@@|@@StartFEN@@(.*?)@@EndFEN@@/gs;

// Un hueco de tres o mas espacios (o una linea en blanco) separa parrafos; con dos
// espacios la exportacion solo aisla jugadas y parentesis dentro de la misma frase.
function parrafos(s) {
  return s
    .replace(/@@StartBracket@@/g, "[")
    .replace(/@@EndBracket@@/g, "]")
    .replace(/@@R@@/g, "[R]")
    .replace(/@@[A-Za-z]+@@/g, "")
    .split(/\n[ \t]*\n|[ \t]{3,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Texto de un comentario como bloques: {t:"p"|"h"|"cita", texto} o {t:"fen", fen}. */
export function bloquesTexto(crudo) {
  const out = [];
  const añadir = (s, t = "p") => {
    for (const texto of parrafos(s)) out.push({ t, texto });
  };
  let i = 0;
  for (const m of (crudo || "").matchAll(BLOQUE)) {
    añadir(crudo.slice(i, m.index));
    if (m[1] !== undefined) añadir(m[1], "h");
    else if (m[2] !== undefined) añadir(m[2], "cita");
    else if (m[3].trim()) out.push({ t: "fen", fen: m[3].trim() });
    i = m.index + m[0].length;
  }
  añadir((crudo || "").slice(i));
  return out;
}

// Comentarios: saca [%cal ...]/[%csl ...] como flechas y quita el resto de comandos [%...].
// El texto queda en parrafos separados por una linea en blanco.
export function limpiarComentario(texto) {
  const formas = [];
  const sinOrdenes = (texto || "")
    .replace(/\[%(cal|csl)\s+([^\]]*)\]/g, (_, tipo, lista) => {
      for (const it of lista.split(",").map((s) => s.trim())) {
        const pincel = PINCEL[it[0]] || "green";
        if (tipo === "cal" && /^[RGYB]?[a-h][1-8][a-h][1-8]$/.test(it)) {
          const s = it.replace(/^[RGYB]/, "");
          formas.push({ orig: s.slice(0, 2), dest: s.slice(2, 4), brush: pincel });
        } else if (tipo === "csl" && /^[RGYB]?[a-h][1-8]$/.test(it)) {
          formas.push({ orig: it.replace(/^[RGYB]/, ""), brush: pincel });
        }
      }
      return "";
    })
    .replace(/\[%[^\]]*\]/g, "");
  const limpio = bloquesTexto(sinOrdenes)
    .map((b) => (b.t === "fen" ? "[diagrama]" : b.texto))
    .join("\n\n");
  return { texto: limpio, formas };
}

// ------------------------------------------------------------------ validacion

/** Recorre el arbol con un solo Chess (move/undo) y rellena uci, fen, color y ply. */
function validar(partida) {
  const fen0 = partida.cabeceras.FEN || FEN_INICIAL;
  let chess;
  try {
    chess = new Chess(fen0);
  } catch {
    return { ok: false, ilegales: 0, error: `FEN inválido: ${fen0}` };
  }
  const raiz = partida.raiz;
  raiz.fen = chess.fen();
  let ilegales = 0;
  const contar = (n) => 1 + n.hijos.reduce((s, h) => s + contar(h), 0);
  const visitar = (nodo) => {
    nodo.hijos = nodo.hijos.filter((h) => {
      let mv = null;
      try {
        mv = chess.move(h.san);
      } catch {
        mv = null;
      }
      if (!mv) {
        ilegales += contar(h);
        return false;
      }
      h.san = mv.san;
      h.uci = mv.from + mv.to + (mv.promotion || "");
      h.desde = mv.from;
      h.hasta = mv.to;
      h.color = mv.color;
      h.fen = mv.after;
      h.captura = !!mv.captured;
      const c = limpiarComentario(h.comentario);
      h.comentario = c.texto;
      h.formas = c.formas;
      const pc = limpiarComentario(h.pre);
      h.pre = pc.texto;
      if (!h.formas.length) h.formas = pc.formas;
      visitar(h);
      chess.undo();
      return true;
    });
  };
  visitar(raiz);
  const rc = limpiarComentario(raiz.comentario);
  raiz.comentario = rc.texto;
  raiz.formas = rc.formas;
  return { ok: true, ilegales };
}

// ------------------------------------------------------------------ nombres

const vale = (v) => (v && !/^\?+$/.test(v.trim()) ? v.trim() : "");

function nombreCapitulo(cab, i, eventosRepetidos, tipo = "Capítulo") {
  if (vale(cab.ChapterName)) return vale(cab.ChapterName);
  if (vale(cab.Chapter)) return vale(cab.Chapter);
  const ev = vale(cab.Event);
  if (ev.includes(": ")) return ev.split(": ").slice(1).join(": ");
  const jugadores = [vale(cab.White), vale(cab.Black)].filter(Boolean).join(" – ");
  if (ev && !eventosRepetidos.has(ev)) return ev;
  if (jugadores) return jugadores;
  return `${tipo} ${i + 1}`;
}

export function numeroJugada(fenAntes, color, san) {
  const n = fenAntes.split(" ")[5] || "1";
  return color === "w" ? `${n}.${san}` : `${n}...${san}`;
}

function etiquetaLinea(nodos) {
  const partes = [];
  for (const n of nodos) {
    if (n.padre.hijos.length > 1 && n.padre.hijos[0] !== n) partes.push(numeroJugada(n.padre.fen, n.color, n.san));
  }
  if (!partes.length) return "Línea principal";
  return partes.length > 3 ? `… ${partes.slice(-3).join(" · ")}` : partes.join(" · ");
}

// Hash corto y estable (cyrb53) para identificar lineas.
function hash(str) {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Palabras de texto (comentarios) que hay en todo el arbol de una partida. */
function palabrasDeArbol(raiz) {
  let n = 0;
  const contar = (s) => {
    if (s && s !== "[diagrama]") n += s.split(/\s+/).filter(Boolean).length;
  };
  const visitar = (x) => {
    contar(x.comentario);
    contar(x.pre);
    x.hijos.forEach(visitar);
  };
  visitar(raiz);
  return n;
}

// ------------------------------------------------------------------ curso

/** Nombre de curso a partir de las cabeceras (StudyName de Lichess, o Event hasta los ":"). */
export function nombreSugerido(texto) {
  const cab = leerPartidas(texto)[0]?.cabeceras || {};
  const ev = vale(cab.Event);
  return vale(cab.StudyName) || (ev.includes(": ") ? ev.split(": ")[0] : ev);
}

const DEFENSAS_NEGRAS =
  /\b(black|negras|french|francesa|sicilian|siciliana|najdorf|dragon|drag[oó]n|caro|nimzo|gr[uü]nfeld|king'?s indian|india de rey|pirc|moderna|scandinavian|escandinava|dutch|holandesa|benoni|slav|eslava|alekhine|philidor|petroff?|berlin|berl[ií]n|semi-?slav|qgd|ragozin|bogo)\b/;
const APERTURAS_BLANCAS = /\b(white|blancas|london|londres|italian|italiana|ruy|espa[nñ]ola|catalan|catalana|english|inglesa|scotch|escocesa|vienna|viena|jobava|colle|trompowsky|king'?s gambit|gambito de rey)\b/;

/**
 * Adivina con que bando se entrena. Por orden: cabecera Orientation (estudios de Lichess),
 * ejercicios desde FEN (el que mueve), donde ramifica el arbol (el autor da varias
 * respuestas del rival y una sola tuya) y, si no hay variantes, el nombre.
 */
export function adivinarColor(texto, nombre = "") {
  const partidas = leerPartidas(texto);
  const orient = partidas.map((p) => (p.cabeceras.Orientation || "").toLowerCase()).find(Boolean);
  if (orient === "black") return "b";
  if (orient === "white") return "w";
  if (partidas.length && partidas.every((p) => p.cabeceras.FEN)) return "auto";

  const ramas = { w: 0, b: 0 };
  for (const p of partidas) {
    const blancasPrimero = (p.cabeceras.FEN || FEN_INICIAL).split(" ")[1] !== "b";
    const visitar = (nodo, prof) => {
      // Los hijos de un nodo a profundidad `prof` son la jugada numero prof+1.
      const mueve = (prof % 2 === 0) === blancasPrimero ? "w" : "b";
      if (nodo.hijos.length > 1) ramas[mueve] += nodo.hijos.length - 1;
      for (const h of nodo.hijos) visitar(h, prof + 1);
    };
    visitar(p.raiz, 0);
  }
  if (ramas.w + ramas.b >= 2 && ramas.w !== ramas.b) return ramas.w > ramas.b ? "b" : "w";

  const s = `${nombre} ${partidas[0]?.cabeceras.Event || ""}`.toLowerCase();
  if (DEFENSAS_NEGRAS.test(s)) return "b";
  if (APERTURAS_BLANCAS.test(s)) return "w";
  return "w";
}

/**
 * Construye el modelo entrenable de un curso.
 * @returns {{id, nombre, color, capitulos, lineas, tarjetas: Map, ilegales, avisos}}
 */
export function construirCurso(meta, texto) {
  const todas = leerPartidas(texto, { conTexto: true });
  const partidas = todas.filter((p) => p.tieneJugadas);
  const cuenta = new Map();
  for (const p of partidas) {
    const ev = vale(p.cabeceras.Event);
    if (ev) cuenta.set(ev, (cuenta.get(ev) || 0) + 1);
  }
  const eventosRepetidos = new Set([...cuenta].filter(([, n]) => n > 1).map(([e]) => e));

  const curso = { id: meta.id, nombre: meta.nombre, color: meta.color, meta, capitulos: [], lecturas: [], lineas: [], tarjetas: new Map(), ilegales: 0, avisos: [] };
  const vistas = new Set();

  // Paginas de lectura: capitulos que no se entrenan pero tienen texto. Son los que solo
  // traen texto (prologos, introducciones; tablero en la posicion inicial) y los que tienen
  // jugadas pero ninguna linea nueva para ti (bando contrario, o linea ya vista en otro
  // capitulo). `orden` es el numero de capitulos con jugadas que van antes (para colocarlas
  // en su sitio del libro) y `gi` su posicion en el PGN: la clave de "leido" no depende del
  // bando del curso.
  const gIndice = new Map(todas.map((p, gi) => [p, gi]));
  let conJugadas = 0;
  let sinJugadas = 0;
  for (const p of todas) {
    if (p.tieneJugadas) {
      conJugadas++;
      continue;
    }
    const crudo = p.raiz.comentario;
    if (!bloquesTexto(crudo).length) continue;
    const gi = gIndice.get(p);
    const palabras = crudo.replace(/@@\w+@@/g, " ").split(/\s+/).filter(Boolean).length;
    curso.lecturas.push({ pagina: true, tipo: "texto", key: `${curso.id}|L${gi}`, curso, gi, nombre: nombreCapitulo(p.cabeceras, sinJugadas++, eventosRepetidos, "Texto"), crudo, palabras, fen: FEN_INICIAL, orden: conJugadas });
  }

  partidas.forEach((partida, ci) => {
    const v = validar(partida);
    if (!v.ok) {
      curso.avisos.push(`Capítulo ${ci + 1}: ${v.error}`);
      return;
    }
    curso.ilegales += v.ilegales;
    const raiz = partida.raiz;
    const color = meta.color === "auto" ? raiz.fen.split(" ")[1] : meta.color;
    const cap = { i: curso.capitulos.length, orden: ci, nombre: nombreCapitulo(partida.cabeceras, ci, eventosRepetidos), cabeceras: partida.cabeceras, raiz, color, lineas: [] };

    const camino = [];
    const hojas = (nodo) => {
      if (!nodo.hijos.length) {
        if (!camino.some((n) => n.color === color)) return;
        const firma = raiz.fen + "|" + camino.map((n) => n.uci).join(" ");
        const key = hash(`${curso.id}|${color}|${firma}`); // cambiar de bando = lineas nuevas
        if (vistas.has(key)) return;
        vistas.add(key);
        const nodos = camino.slice();
        const linea = { key, curso, capitulo: cap, idx: curso.lineas.length, nodos, color, etiqueta: etiquetaLinea(nodos), tarjetas: [] };
        for (const n of nodos) {
          if (n.color !== color) continue;
          const k = claveTarjeta(curso.id, n.padre.fen, n.uci);
          let t = curso.tarjetas.get(k);
          if (!t) {
            const previo = n.padre.padre ? n.padre : null;
            t = { key: k, curso, fen: n.padre.fen, san: n.san, uci: n.uci, desde: n.desde, hasta: n.hasta, color, previo: previo ? [previo.desde, previo.hasta] : null, previoSan: previo ? numeroJugada(previo.padre.fen, previo.color, previo.san) : "", comentario: n.comentario, formas: n.formas, lineas: [], capitulo: cap };
            curso.tarjetas.set(k, t);
          }
          if (!t.lineas.includes(linea)) t.lineas.push(linea);
          if (!linea.tarjetas.includes(k)) linea.tarjetas.push(k);
        }
        cap.lineas.push(linea);
        curso.lineas.push(linea);
        return;
      }
      for (const h of nodo.hijos) {
        camino.push(h);
        hojas(h);
        camino.pop();
      }
    };
    hojas(raiz);
    if (cap.lineas.length) curso.capitulos.push(cap);
    else {
      const palabras = palabrasDeArbol(raiz);
      const gi = gIndice.get(partida);
      if (palabras) curso.lecturas.push({ pagina: true, tipo: "partida", key: `${curso.id}|L${gi}`, curso, gi, nombre: cap.nombre, raiz, fen: raiz.fen, color: raiz.fen.split(" ")[1], palabras, orden: ci });
    }
  });
  curso.lecturas.sort((a, b) => a.gi - b.gi).forEach((l, i) => (l.i = i));

  // Indice posicion -> jugadas del repertorio (para "esa jugada es de otra linea").
  curso.porPosicion = new Map();
  for (const t of curso.tarjetas.values()) {
    const k = claveFen(t.fen);
    if (!curso.porPosicion.has(k)) curso.porPosicion.set(k, []);
    curso.porPosicion.get(k).push(t);
  }
  if (curso.ilegales) curso.avisos.push(`${curso.ilegales} jugada(s) ilegal(es) o ilegibles se omitieron junto con lo que venía detrás.`);
  return curso;
}

/**
 * Claves de todas las lineas que el curso puede tener con cualquier bando ("w", "b" o
 * "auto"). Sirve para borrar el progreso de un curso sin importar con que bando se entrenara:
 * las claves son hashes y no se pueden buscar por prefijo.
 */
export function clavesDeLineas(meta, texto) {
  const claves = new Set();
  for (const partida of leerPartidas(texto)) {
    if (!validar(partida).ok) continue;
    const raiz = partida.raiz;
    const lado = raiz.fen.split(" ")[1];
    const camino = [];
    const recorrer = (nodo) => {
      if (!nodo.hijos.length) {
        const firma = raiz.fen + "|" + camino.map((n) => n.uci).join(" ");
        for (const bando of ["w", "b", "auto"]) {
          const color = bando === "auto" ? lado : bando;
          if (camino.some((n) => n.color === color)) claves.add(hash(`${meta.id}|${color}|${firma}`));
        }
        return;
      }
      for (const h of nodo.hijos) {
        camino.push(h);
        recorrer(h);
        camino.pop();
      }
    };
    recorrer(raiz);
  }
  return claves;
}

/** Texto de la linea con numeracion: "1.e4 e5 2.Nf3 …". */
export function textoLinea(nodos, hasta = nodos.length) {
  const out = [];
  nodos.slice(0, hasta).forEach((n, i) => {
    const num = n.padre.fen.split(" ")[5];
    if (n.color === "w") out.push(`${num}.${n.san}`);
    else out.push(i === 0 ? `${num}...${n.san}` : n.san);
  });
  return out.join(" ");
}
