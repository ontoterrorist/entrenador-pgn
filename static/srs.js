// Repeticion espaciada al estilo MoveTrainer de Chessable.
//
// Cada tarjeta (posicion + jugada tuya) tiene un nivel 1..9. Acertar una tarjeta que ya
// tocaba repasar la sube un nivel; acertar una que aun no tocaba no la mueve (no se
// "adelanta" el calendario repasando antes de tiempo). Fallar la devuelve al nivel 1
// (o baja dos niveles en modo suave) y la agenda para dentro de 4 h. Ademas cada fallo
// suma "debilidad", que se descuenta con aciertos: eso alimenta la practica de errores.

export const H = 3600e3;
export const D = 24 * H;
// Un pelin menos de 1 dia/semana/... para que el repaso caiga a la misma hora del dia.
export const INTERVALOS = [0, 4 * H, 20 * H, 3 * D - 2 * H, 7 * D - 2 * H, 14 * D - 2 * H, 30 * D, 90 * D, 180 * D, 365 * D];
export const NIVEL_MAX = INTERVALOS.length - 1;
export const NIVEL_CONSOLIDADA = 5;
const DEBILIDAD_FALLO = 2;
const DEBILIDAD_MAX = 8;
const MAX_ERRORES_LOG = 5000;

export const AJUSTES_DEFECTO = {
  castigo: "reinicio", // "reinicio" (nivel 1, como Chessable) | "suave" (-2 niveles)
  lineasRepaso: 20,
  lineasNuevas: 5,
  posicionesErrores: 20,
  retardo: 450, // ms antes de que el rival mueva
  sonido: true,
  coordenadas: true,
  avanceAuto: true,
  comentariosEnRepaso: true, // el texto del PGN tambien en repaso (apagado: solo tras un fallo)
  mostrarJugada: false, // flecha y texto con la jugada correcta (al aprender y tras un fallo)
  pgnCompleto: true, // el panel muestra la linea entera del PGN desde el principio (apagado: hasta la jugada actual)
  tamTablero: 100, // tamano del tablero, % del espacio disponible (40-100)
  timer: false, // cuenta atras en cada jugada tuya
  timerSeg: 30, // segundos por jugada
  timerFallo: false, // al agotarse, la posicion cuenta como fallo
};

export function progresoVacio() {
  return { v: 1, tarjetas: {}, lineas: {}, lecturas: {}, errores: [], dias: {}, ajustes: { ...AJUSTES_DEFECTO } };
}

export function normalizar(p) {
  const base = progresoVacio();
  if (!p || typeof p !== "object") return base;
  return {
    v: 1,
    tarjetas: p.tarjetas || {},
    lineas: p.lineas || {},
    lecturas: p.lecturas || {}, // paginas de texto ya leidas: clave -> cuando
    errores: Array.isArray(p.errores) ? p.errores : [],
    dias: p.dias || {},
    ajustes: { ...AJUSTES_DEFECTO, ...(p.ajustes || {}) },
  };
}

export const hoyClave = (t = Date.now()) => new Date(t).toLocaleDateString("sv-SE"); // AAAA-MM-DD local

const variacion = (ms) => Math.round(ms * (0.95 + Math.random() * 0.1)); // reparte los repasos

export function tocaRepasar(t, ahora = Date.now()) {
  return !!t && t.nv > 0 && t.vence <= ahora;
}

function dia(P, ahora) {
  const k = hoyClave(ahora);
  return (P.dias[k] ||= { rep: 0, ok: 0, nuevas: 0, lineas: 0 });
}

/**
 * Califica un intento sobre una tarjeta. Devuelve una "foto" para poder deshacerlo
 * (boton "Fue un desliz").
 */
export function calificar(P, clave, acierto, { ahora = Date.now(), modo = "repaso", jugada = "", contexto = {} } = {}) {
  const antes = P.tarjetas[clave] ? { ...P.tarjetas[clave] } : null;
  const d = dia(P, ahora);
  const diaAntes = { ...d };
  const t = (P.tarjetas[clave] ||= { nv: 0, vence: 0, reps: 0, fallos: 0, deb: 0, ult: 0 });
  let errorAnotado = false;

  if (acierto) {
    if (t.nv === 0) {
      t.nv = 1;
      t.vence = ahora + INTERVALOS[1];
      d.nuevas++;
    } else if (t.vence <= ahora) {
      t.nv = Math.min(t.nv + 1, NIVEL_MAX);
      t.vence = ahora + variacion(INTERVALOS[t.nv]);
    }
    t.deb = Math.max(0, t.deb - 1);
    d.ok++;
  } else {
    t.fallos++;
    t.deb = Math.min(DEBILIDAD_MAX, t.deb + DEBILIDAD_FALLO);
    t.nv = P.ajustes.castigo === "suave" ? Math.max(1, t.nv - 2) : 1;
    t.vence = ahora + INTERVALOS[1];
    P.errores.push({ t: ahora, k: clave, jugada, modo, ...contexto });
    if (P.errores.length > MAX_ERRORES_LOG) P.errores.splice(0, P.errores.length - MAX_ERRORES_LOG);
    errorAnotado = true;
  }
  t.reps++;
  t.ult = ahora;
  d.rep++;
  return { clave, antes, errorAnotado, diaClave: hoyClave(ahora), diaAntes };
}

export function deshacer(P, foto) {
  if (!foto) return;
  if (foto.antes) P.tarjetas[foto.clave] = foto.antes;
  else delete P.tarjetas[foto.clave];
  if (foto.errorAnotado) {
    const i = P.errores.findLastIndex((e) => e.k === foto.clave);
    if (i >= 0) P.errores.splice(i, 1);
  }
  P.dias[foto.diaClave] = foto.diaAntes;
}

/** Aprender una linea: sus tarjetas nuevas pasan a nivel 1 (repaso en 4 h). */
export function aprenderLinea(P, linea, ahora = Date.now()) {
  const d = dia(P, ahora);
  for (const k of linea.tarjetas) {
    const t = (P.tarjetas[k] ||= { nv: 0, vence: 0, reps: 0, fallos: 0, deb: 0, ult: 0 });
    if (t.nv > 0) continue; // ya la conocias por otra linea: no se toca su calendario
    t.nv = 1;
    t.vence = ahora + INTERVALOS[1];
    t.ult = ahora;
    d.nuevas++;
  }
  P.lineas[linea.key] = { aprendida: ahora };
  d.lineas++;
}

// ------------------------------------------------------------------ consultas

export function estadoLinea(P, linea, ahora = Date.now()) {
  const aprendida = !!P.lineas[linea.key];
  let pendientes = 0;
  let proxima = Infinity;
  let nvMin = Infinity;
  for (const k of linea.tarjetas) {
    const t = P.tarjetas[k];
    if (!t || t.nv === 0) {
      nvMin = 0;
      continue;
    }
    if (t.vence <= ahora) pendientes++;
    proxima = Math.min(proxima, t.vence);
    nvMin = Math.min(nvMin, t.nv);
  }
  return { aprendida, pendientes, proxima, nivel: nvMin === Infinity ? 0 : nvMin, pendiente: aprendida && pendientes > 0 };
}

export function resumenCurso(P, curso, ahora = Date.now()) {
  let nuevas = 0,
    pendientes = 0,
    aprendidas = 0,
    consolidadas = 0;
  for (const l of curso.lineas) {
    const e = estadoLinea(P, l, ahora);
    if (!e.aprendida) nuevas++;
    else {
      aprendidas++;
      if (e.pendiente) pendientes++;
      if (e.nivel >= NIVEL_CONSOLIDADA) consolidadas++;
    }
  }
  let posPendientes = 0,
    debiles = 0;
  for (const k of curso.tarjetas.keys()) {
    const t = P.tarjetas[k];
    if (!t) continue;
    if (tocaRepasar(t, ahora)) posPendientes++;
    if (t.deb > 0) debiles++;
  }
  return { total: curso.lineas.length, nuevas, pendientes, aprendidas, consolidadas, posPendientes, debiles, tarjetas: curso.tarjetas.size };
}

/** Lineas aprendidas con alguna tarjeta vencida, las mas atrasadas primero. */
export function lineasPendientes(P, cursos, ahora = Date.now()) {
  const out = [];
  for (const c of cursos)
    for (const l of c.lineas) {
      const e = estadoLinea(P, l, ahora);
      if (!e.pendiente) continue;
      let masVieja = Infinity;
      for (const k of l.tarjetas) {
        const t = P.tarjetas[k];
        if (tocaRepasar(t, ahora)) masVieja = Math.min(masVieja, t.vence);
      }
      out.push({ linea: l, masVieja });
    }
  return out.sort((a, b) => a.masVieja - b.masVieja).map((x) => x.linea);
}

export function lineasNuevas(P, curso) {
  return curso.lineas.filter((l) => !P.lineas[l.key]);
}

/** Tarjetas con debilidad > 0: las mas falladas y recientes primero. */
export function tarjetasDebiles(P, cursos) {
  const out = [];
  for (const c of cursos)
    for (const [k, tarjeta] of c.tarjetas) {
      const t = P.tarjetas[k];
      if (t && t.deb > 0) out.push({ tarjeta, t });
    }
  return out.sort((a, b) => b.t.deb - a.t.deb || b.t.fallos - a.t.fallos || b.t.ult - a.t.ult);
}

/** Posiciones que vencen en cada uno de los proximos `dias` (el dia 0 incluye lo atrasado). */
export function pronostico(P, cursos, dias = 7, ahora = Date.now()) {
  const cuentas = new Array(dias).fill(0);
  const inicioHoy = new Date(ahora);
  inicioHoy.setHours(0, 0, 0, 0);
  for (const c of cursos)
    for (const k of c.tarjetas.keys()) {
      const t = P.tarjetas[k];
      if (!t || t.nv === 0) continue;
      const i = Math.max(0, Math.floor((t.vence - inicioHoy) / D));
      if (i < dias) cuentas[i]++;
    }
  return cuentas;
}

export function racha(P, ahora = Date.now()) {
  let n = 0;
  const d = new Date(ahora);
  if (!P.dias[hoyClave(d)]?.rep) d.setDate(d.getDate() - 1); // hoy aun no cuenta en contra
  while (P.dias[hoyClave(d)]?.rep) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function borrarCurso(P, cursoId) {
  const pref = cursoId + "|";
  for (const k of Object.keys(P.tarjetas)) if (k.startsWith(pref)) delete P.tarjetas[k];
  for (const k of Object.keys(P.lecturas || {})) if (k.startsWith(pref)) delete P.lecturas[k];
  P.errores = P.errores.filter((e) => !e.k.startsWith(pref));
  // Las claves de linea son hashes; se limpian al reconstruir (ver app.js).
}

export function textoIntervalo(ms) {
  if (ms <= 0) return "ya";
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m} min`;
  const h = Math.round(ms / H);
  if (h < 36) return `${h} h`;
  const d = Math.round(ms / D);
  if (d < 45) return `${d} d`;
  const mes = Math.round(d / 30);
  return mes < 12 ? `${mes} mes${mes > 1 ? "es" : ""}` : `${Math.round(d / 365)} año`;
}
