// Envoltorio de chessground + chess.js: tablero interactivo con promocion y flechas.

import { Chessground } from "./vendor/chessground.min.js";
import { Chess } from "./vendor/chess.min.js";

const NOMBRE = { w: "white", b: "black" };
const PIEZA = { q: "queen", r: "rook", b: "bishop", n: "knight" };

export class Tablero {
  /** @param {HTMLElement} el  @param {{alMover: (m:{from,to,promotion?}) => void}} op */
  constructor(el, { alMover }) {
    this.el = el;
    this.alMover = alMover;
    this.chess = new Chess();
    this.orientacion = "w";
    this.cg = Chessground(el, {
      fen: this.chess.fen(),
      coordinates: true,
      animation: { enabled: true, duration: 200 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, color: undefined, showDests: true, events: { after: (o, d) => this._soltar(o, d) } },
      premovable: { enabled: false },
      draggable: { enabled: true, showGhost: true },
      drawable: { enabled: true, visible: true, defaultSnapToValidMove: true },
    });
    let t = 0;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => this.cg.redrawAll(), 60);
    }).observe(el);
  }

  get fen() {
    return this.chess.fen();
  }

  _dests() {
    const dests = new Map();
    for (const m of this.chess.moves({ verbose: true })) {
      if (!dests.has(m.from)) dests.set(m.from, []);
      dests.get(m.from).push(m.to);
    }
    return dests;
  }

  /** Coloca una posicion. `interactivo`: el bando al turno puede mover. */
  posicion(fen, { orientacion = this.orientacion, ultima = null, interactivo = false, formas = [] } = {}) {
    this.chess.load(fen);
    this.orientacion = orientacion;
    const turno = NOMBRE[this.chess.turn()];
    this.cg.set({
      fen,
      orientation: NOMBRE[orientacion],
      turnColor: turno,
      lastMove: ultima || undefined,
      check: this.chess.inCheck() ? turno : false,
      movable: { color: interactivo ? turno : undefined, dests: interactivo ? this._dests() : new Map() },
    });
    this.flechas(formas);
  }

  /** Permite (o bloquea) mover al bando al turno en la posicion actual. */
  activar(si = true) {
    const turno = NOMBRE[this.chess.turn()];
    this.cg.set({ turnColor: turno, movable: { color: si ? turno : undefined, dests: si ? this._dests() : new Map() } });
  }

  /** Juega una jugada (uci) con animacion y deja el tablero sincronizado. */
  jugar(uci, { interactivo = false, formas = [] } = {}) {
    const mv = this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    const turno = NOMBRE[this.chess.turn()];
    this.cg.move(mv.from, mv.to);
    this.cg.set({
      fen: this.chess.fen(), // corrige enroque, al paso y promocion
      turnColor: turno,
      lastMove: [mv.from, mv.to],
      check: this.chess.inCheck() ? turno : false,
      movable: { color: interactivo ? turno : undefined, dests: interactivo ? this._dests() : new Map() },
    });
    this.flechas(formas);
    return mv;
  }

  /** Vuelve a pintar la posicion actual (p. ej. tras una jugada rechazada). */
  restaurar({ interactivo = true, ultima, formas } = {}) {
    const turno = NOMBRE[this.chess.turn()];
    this.cg.set({
      fen: this.chess.fen(),
      turnColor: turno,
      lastMove: ultima,
      check: this.chess.inCheck() ? turno : false,
      movable: { color: interactivo ? turno : undefined, dests: interactivo ? this._dests() : new Map() },
    });
    if (formas) this.flechas(formas);
  }

  flechas(formas = []) {
    this.cg.setAutoShapes(formas);
  }

  /** Traduce from/to/promocion a SAN sin tocar la posicion. */
  san({ from, to, promotion }) {
    try {
      const m = this.chess.move({ from, to, promotion });
      this.chess.undo();
      return m.san;
    } catch {
      return `${from}-${to}`;
    }
  }

  async _soltar(orig, dest) {
    const pieza = this.chess.get(orig);
    let promotion;
    if (pieza?.type === "p" && (dest[1] === "8" || dest[1] === "1")) {
      promotion = await this._elegirPromocion(pieza.color, dest);
      if (!promotion) return this.restaurar();
    }
    this.alMover({ from: orig, to: dest, promotion });
  }

  _elegirPromocion(color, dest) {
    return new Promise((resolver) => {
      const capa = document.createElement("div");
      capa.className = "promo cg-wrap";
      const col = dest.charCodeAt(0) - 97;
      const x = this.orientacion === "w" ? col : 7 - col;
      const arriba = (dest[1] === "8") === (this.orientacion === "w");
      const caja = document.createElement("div");
      caja.className = "promo-caja";
      caja.style.left = `${x * 12.5}%`;
      caja.style[arriba ? "top" : "bottom"] = "0";
      for (const letra of ["q", "n", "r", "b"]) {
        const b = document.createElement("button");
        b.type = "button";
        b.title = { q: "Dama", n: "Caballo", r: "Torre", b: "Alfil" }[letra];
        b.innerHTML = `<piece class="${PIEZA[letra]} ${NOMBRE[color]}"></piece>`;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          capa.remove();
          resolver(letra);
        });
        caja.append(b);
      }
      capa.append(caja);
      capa.addEventListener("click", () => {
        capa.remove();
        resolver(null);
      });
      this.el.parentElement.append(capa);
    });
  }
}
