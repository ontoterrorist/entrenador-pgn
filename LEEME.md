# Entrenador PGN

Entrenador de repertorio al estilo MoveTrainer de Chessable, con repetición espaciada. Sube tus PGN y la app convierte cada variante en una línea: juega las jugadas del rival y te pregunta las tuyas.

## Abrir

Doble clic en el acceso **Entrenador PGN** del escritorio, o en **`Entrenador PGN.bat`** de esta carpeta. Arranca un servidor local en http://127.0.0.1:8777 y abre el navegador. El acceso llama directamente a `pyw server.py`, sin consola; su icono es `static/icono.ico`.

- El servidor sigue encendido mientras la pestaña esté abierta. Al cerrarla, se apaga solo en unos 30 s. Recargar la pestaña no lo apaga.
- Si ya estaba abierto, el `.bat` abre otra pestaña y no arranca un segundo servidor.
- Para dejarlo siempre encendido: `py server.py --siempre`.

## Versión web (sin servidor)

La carpeta `static/` también funciona sola, como sitio estático (GitHub Pages o cualquier servidor de archivos), y bajo un subpath como `/entrenador-pgn/`: todas las rutas son relativas.

- Al arrancar, la app pregunta por `api/ping`. Si contesta `server.py`, todo va como siempre. Si no, entra en **modo navegador** (arriba a la derecha dice «en este navegador»): los cursos y el progreso se guardan en IndexedDB, en el propio navegador. `static/almacen.js` contesta las mismas rutas que el servidor, con el mismo control de conflictos entre pestañas.
- Cada navegador (y cada sitio) guarda sus datos aparte. Para llevarte tus cursos de la versión local a la web, o de un navegador a otro: *Ajustes → Tus datos → Exportar copia completa* (un JSON con los PGN y el progreso) y, en el otro lado, **Importar**. Los cursos conservan su id, así que el progreso encaja; los que ya estaban se dejan como están y el progreso se reemplaza por el del archivo. Al revés (de la web a la local) funciona igual.
- En modo navegador no hay pestaña **Catálogo**: el repo de ChessNomad no tiene licencia, así que su CSV no se publica. Tampoco hay copias automáticas ni papelera: exporta una copia de vez en cuando. Si borras los datos del sitio en el navegador, se pierden.
- Publicado en https://ontoterrorist.github.io/entrenador-pgn/ desde la rama `gh-pages`, que es una copia de `static/`. Tras cambiar algo en `static/` y hacer commit en `main`, se actualiza con `git subtree push --prefix static origin gh-pages`.
- Los cursos que subas en la web no salen de tu navegador: no se suben a ningún servidor ni al repo.

## Uso

- **Subir PGN**: con el botón, arrastrando archivos a la ventana o pegando el texto. Sirve cualquier PGN con variantes (estudio de Lichess, base de ChessBase, tu repertorio). Los archivos en Latin-1 de ChessBase se leen bien. El bando se detecta solo: primero por la cabecera `Orientation`, luego por dónde ramifica el árbol y, si no, por el nombre. Puedes cambiarlo.
- **Aprender**: una flecha marca tu jugada y ves los comentarios y las flechas `[%cal]`/`[%csl]` del PGN.
- **Repasar**: sin ayudas. Cada posición sube de nivel cuando la aciertas en su día: 4 h → 20 h → 3 d → 1 sem → 2 sem → 1 mes → 3 meses → 6 meses → 1 año.
- **Fallos**: la posición vuelve al nivel 1 (o baja 2 niveles en modo suave) y se guarda en *Errores*. Sale de la lista de débiles cuando la aciertas dos veces.
  - Si fallas al soltar la pieza, **Fue un desliz** (`D`) anula ese fallo.
  - Si juegas otra jugada de tu repertorio que pertenece a otra línea, se te avisa y no cuenta como fallo.
- **Mostrar mejor jugada** (apagado por defecto): interruptor en el panel de entrenamiento (y en *Ajustes*). Apagado, no hay flecha ni texto con la jugada correcta, ni al aprender ni tras un fallo: tienes que encontrarla. La pista (`H`) sigue revelándola. Si lo enciendes tras un fallo, la jugada aparece al momento.
- **Texto del PGN** (encendido por defecto), siempre en pantalla, sin ventanas aparte:
  - **En el panel de entrenamiento**, junto al tablero: el PGN de la línea entera con sus comentarios, desde el principio y también en repaso (lo que aún no has jugado, atenuado). **Ocultar el resto** lo deja solo hasta la jugada actual, sin adelantar la respuesta, y **Ver PGN completo** lo vuelve a abrir. Es un ajuste (`pgnCompleto`, encendido por defecto): se queda como lo dejes.
  - **Páginas de texto**: los capítulos que solo traen texto (prólogos, introducciones, notas del autor) se muestran en el entrenador con el tablero en la posición inicial y todo el texto en el panel, antes de las líneas que vienen detrás en el libro. Al aprender salen primero las que aún no has leído y se pasan con **Siguiente** (`Enter`); quedan marcadas como leídas. También cuentan los capítulos con jugadas pero sin línea nueva para ti (el bando contrario, o una línea ya vista en otro capítulo): se leen con su posición y el árbol de jugadas con variantes y comentarios.
  - **Atrás**: en una página de texto, **← Atrás** (`←`) vuelve a la página de texto anterior de la sesión; `→` también pasa a la siguiente. Una línea ya hecha no se repite desde ahí.
  - **En la vista del curso** salen en su sitio del libro, con su estado (*sin leer* / *leído*), y se despliegan al pulsarlos igual que los capítulos; abrirlas las marca como leídas. No se entrenan.
  - El texto que sigue a una jugada nula (`1. --`) también se conserva: antes se perdía.
  - El interruptor «Texto del PGN» del panel es el mismo ajuste de *Ajustes*. Apagado, en repaso solo ves el comentario de la jugada que fallas.
  - Las marcas de Chessable (`@@HeaderStart@@`, citas, notas, enlaces, diagramas `@@StartFEN@@`) se convierten en títulos, citas y tableros.
  - Los valores por defecto solo cuentan hasta que cambias un ajuste: se guardan en `progreso.json`.
- **Tres columnas** (pantallas de más de 1180 px): tablero, texto del PGN (comentarios, línea completa y páginas de texto, con su propio desplazamiento) y panel de control a la derecha. En pantallas más estrechas el panel queda junto al tablero y el texto debajo de él.
- **Tamaño del tablero**: deslizador «Tablero» en el panel de entrenamiento (y en *Ajustes*), del 40 al 100 % del espacio disponible. Lo que libera el tablero al achicarlo se lo queda la columna del texto. Se guarda.
- **Timer** (panel de entrenamiento y *Ajustes*, apagado por defecto): cuenta atrás en cada jugada tuya, al aprender, repasar, practicar y en errores. Los segundos los escribes en la casilla (o con las flechas), de 1 a 3600; si lo cambias con el reloj en marcha, empieza de nuevo. Al agotarse avisa «¡Se acabó el tiempo!»; con **Fallo al agotarse** la posición además cuenta como fallo en repaso, práctica y errores (y **Fue un desliz** lo anula). Un acierto detiene el reloj, que arranca otra vez en tu siguiente jugada.
- **Eliminar progreso** (vista del curso y tarjetas de *Tus cursos*, junto a *Aprender*): deja el curso como nuevo —líneas aprendidas, niveles, fallos y textos leídos, con cualquier bando con el que lo hubieras entrenado— y conserva el curso y su PGN. Pide confirmación y dice qué se olvida. Las estadísticas por día (racha, repasos de hoy) no son de un curso y se conservan.
- **Quién juega**: bajo el título del panel, en grande, «Juegan blancas» o «Juegan negras» (con «· tú» o «· rival» en las líneas y errores), se actualiza en cada jugada. También sale en las páginas de texto que traen una posición.
- **Atajos**: `H` pista (cuenta como fallo), `Enter` siguiente, `Esc` salir, `←`/`→` entre páginas de texto.
- **Catálogo** (solo en la versión local): los 376 cursos de Chessable del repo [ChessNomad/chessable-courses](https://github.com/ChessNomad/chessable-courses) (metadatos de julio de 2020, sin jugadas). Si tienes el PGN de uno de esos cursos, súbelo desde su fila y queda vinculado.

## Datos

Todo se guarda en `data/`:

- `progreso.json`: niveles, fallos y estadísticas.
- `cursos.json` y `cursos/*.pgn`: tus cursos.
- `copias/`: una copia del progreso en cada arranque; se guardan las últimas 15.
- `papelera/`: los PGN de los cursos que elimines.
- `servidor.log`: el registro del servidor cuando se abre sin consola.

Si el servidor se cae con la pestaña abierta, lo no guardado queda en el navegador y se recupera al volver a abrir.

## Archivos

- `server.py`: servidor (solo biblioteca estándar de Python). Se encarga de la persistencia y del ciclo de vida atado a la pestaña.
- `static/almacen.js`: la persistencia del modo navegador (IndexedDB), con las mismas rutas y respuestas que `server.py`.
- `static/pgn.js`: lee el PGN y construye el árbol de variantes, las líneas y las tarjetas; también separa los capítulos de solo texto (`curso.lecturas`) y limpia los comentarios (`bloquesTexto`).
- `static/srs.js`: calendario de repetición espaciada.
- `static/sonidos.js`: efectos de 8 bits al estilo Game Boy, sintetizados con ondas de pulso. Solo suenan al fallar y al terminar una línea; las jugadas van en silencio. Se escuchan en *Ajustes → Sonido → ▶ Escuchar*.
- `static/app.js`: interfaz.
- `static/tablero.js`: tablero, con chessground y chess.js en `static/vendor`, copiados del tablero de análisis y sin necesidad de internet.
