// Almacen del navegador: lo que hace server.py, pero en IndexedDB, para cuando la app se
// sirve como sitio estatico (GitHub Pages). Contesta las mismas rutas que /api/ con las
// mismas respuestas y los mismos errores, asi app.js no distingue un modo del otro.
//
//   kv/cursos    lista de cursos (lo que en local es data/cursos.json)
//   kv/progreso  { rev, guardado, data }  (data/progreso.json)
//   pgn/<id>     texto del PGN de cada curso (data/cursos/<id>.pgn)

const DB = "entrenador-pgn";
const ID = /^[0-9a-f]{12}$/;
const RUTA_CURSO = /^cursos\/([0-9a-f]{12})(\.pgn)?$/;

// La app sirvio la pagina desde server.py si este contesta al ping.
export async function hayServidor() {
  try {
    const r = await fetch("api/ping", { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return r.ok && (await r.json()).app === "entrenador-pgn";
  } catch {
    return false;
  }
}

let conexion = null;
function abrir() {
  conexion ??= new Promise((ok, mal) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("kv");
      r.result.createObjectStore("pgn");
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      ok(r.result);
    };
    r.onerror = () => mal(r.error);
  });
  return conexion;
}

// Una transaccion: fn recibe el almacen por nombre y `pedir`, que convierte una peticion
// IDB en promesa. Si fn lanza, la transaccion se aborta y no se escribe nada.
async function transaccion(almacenes, modo, fn) {
  const db = await abrir();
  return new Promise((ok, mal) => {
    const t = db.transaction(almacenes, modo);
    const pedir = (req) => new Promise((o) => (req.onsuccess = () => o(req.result)));
    let res;
    Promise.resolve(fn((n) => t.objectStore(n), pedir)).then(
      (r) => (res = r),
      (e) => {
        mal(e);
        try {
          t.abort();
        } catch {}
      },
    );
    t.oncomplete = () => ok(res);
    t.onerror = t.onabort = () => mal(t.error || new Error("transacción abortada"));
  });
}

const fallo = (status, error, extra = {}) => Object.assign(new Error(error), { status, datos: { error, ...extra } });
const nuevoId = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
const ahora = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 19); // local, como server.py

export async function apiNavegador(ruta, metodo = "GET", cuerpo = {}) {
  if (metodo === "GET" && ruta === "estado")
    return transaccion(["kv"], "readonly", async (st, pedir) => ({
      cursos: (await pedir(st("kv").get("cursos"))) || [],
      progreso: (await pedir(st("kv").get("progreso"))) || { rev: 0, data: null },
    }));

  if (metodo === "POST" && ruta === "progreso") {
    if (!cuerpo.data || typeof cuerpo.data !== "object") throw fallo(400, "falta data");
    return transaccion(["kv"], "readwrite", async (st, pedir) => {
      const actual = (await pedir(st("kv").get("progreso"))) || { rev: 0 };
      if (cuerpo.baseRev !== actual.rev) throw fallo(409, "conflicto", { rev: actual.rev });
      const rev = actual.rev + 1;
      st("kv").put({ rev, guardado: ahora(), data: cuerpo.data }, "progreso");
      return { rev };
    });
  }

  if (metodo === "POST" && ruta === "cursos") {
    const { pgn, color } = cuerpo;
    const nombre = String(cuerpo.nombre || "").trim().slice(0, 200);
    if (typeof pgn !== "string" || !pgn.trim() || !nombre || !["w", "b", "auto"].includes(color)) throw fallo(400, "faltan nombre, color o pgn");
    const meta = {
      id: ID.test(cuerpo.id) ? cuerpo.id : nuevoId(),
      nombre,
      color,
      creado: ahora(),
      catalogo: cuerpo.catalogo && typeof cuerpo.catalogo === "object" ? cuerpo.catalogo : null,
      archivos: (cuerpo.archivos || []).slice(0, 50).map((a) => String(a).slice(0, 200)),
    };
    await transaccion(["kv", "pgn"], "readwrite", async (st, pedir) => {
      const lista = (await pedir(st("kv").get("cursos"))) || [];
      if (lista.some((c) => c.id === meta.id)) throw fallo(409, "ya existe un curso con ese id");
      st("pgn").put(pgn, meta.id);
      st("kv").put([...lista, meta], "cursos");
    });
    navigator.storage?.persist?.(); // que el navegador no lo borre si le falta espacio
    return meta;
  }

  const m = RUTA_CURSO.exec(ruta);
  if (m && m[2] && metodo === "GET") return transaccion(["pgn"], "readonly", (st, pedir) => pedir(st("pgn").get(m[1]))).then((t) => t ?? "");

  if (m && !m[2] && (metodo === "POST" || metodo === "DELETE"))
    return transaccion(["kv", "pgn"], "readwrite", async (st, pedir) => {
      const lista = (await pedir(st("kv").get("cursos"))) || [];
      const meta = lista.find((c) => c.id === m[1]);
      if (!meta) throw fallo(404, "curso no encontrado");
      if (metodo === "DELETE") {
        st("kv").put(lista.filter((c) => c !== meta), "cursos");
        st("pgn").delete(m[1]);
        return { ok: true };
      }
      if (typeof cuerpo.nombre === "string" && cuerpo.nombre.trim()) meta.nombre = cuerpo.nombre.trim().slice(0, 200);
      if (["w", "b", "auto"].includes(cuerpo.color)) meta.color = cuerpo.color;
      st("kv").put(lista, "cursos");
      return meta;
    });

  throw fallo(404, "ruta desconocida");
}
