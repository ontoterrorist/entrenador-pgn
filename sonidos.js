// Sonidos de 8 bits al estilo Game Boy, sintetizados con Web Audio.
//
// Solo hay dos: el fallo y el final de una linea (las jugadas van en silencio). Imitan los
// canales de pulso del GB: ondas cuadradas con ciclo de trabajo de 12,5 / 25 / 50 %. Para que
// suenen limpios: las ondas se construyen con armonicos limitados (sin aliasing), cada nota
// entra y sale con una rampa de pocos ms (sin clics), y la salida pasa por un paso alto y un
// paso bajo suaves, como el condensador y el altavoz de la consola.

const NOTAS = { Bb3: 233.08, Eb4: 311.13, C5: 523.25, E5: 659.25, G5: 783.99, C6: 1046.5 };

/** Crea un motor de sonido sobre un AudioContext (u OfflineAudioContext, para pruebas). */
export function crearMotor(ctx, { volumen = 0.22 } = {}) {
  const salida = ctx.createGain();
  salida.gain.value = volumen;
  const pasoAlto = ctx.createBiquadFilter();
  pasoAlto.type = "highpass";
  pasoAlto.frequency.value = 90;
  const pasoBajo = ctx.createBiquadFilter();
  pasoBajo.type = "lowpass";
  pasoBajo.frequency.value = 6500;
  pasoBajo.Q.value = 0.5;
  // Sin compresor: el de Chrome mete ganancia automatica y desequilibra sonidos cortos y largos.
  salida.connect(pasoAlto).connect(pasoBajo).connect(ctx.destination);

  // Onda de pulso con ciclo de trabajo `ciclo` (serie de Fourier; Web Audio la limita en banda).
  const ondas = new Map();
  const pulso = (ciclo) => {
    if (!ondas.has(ciclo)) {
      const N = 64;
      const re = new Float32Array(N);
      const im = new Float32Array(N);
      for (let n = 1; n < N; n++) {
        re[n] = Math.sin(2 * Math.PI * n * ciclo) / (n * Math.PI);
        im[n] = (1 - Math.cos(2 * Math.PI * n * ciclo)) / (n * Math.PI);
      }
      ondas.set(ciclo, ctx.createPeriodicWave(re, im));
    }
    return ondas.get(ciclo);
  };

  const ATAQUE = 0.004;
  const SALIDA = 0.012;

  /**
   * Una nota de pulso. `forma`: "golpe" (cae enseguida, como un blip) o "plana" (se sostiene
   * y corta, como las notas de una melodia de GB).
   */
  function nota({ f, t = 0, dur = 0.08, ciclo = 0.5, vol = 1, forma = "golpe" }) {
    const t0 = ctx.currentTime + 0.005 + t;
    const o = ctx.createOscillator();
    o.setPeriodicWave(pulso(ciclo));
    o.frequency.setValueAtTime(f, t0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + ATAQUE);
    if (forma === "plana") {
      g.gain.setValueAtTime(vol, t0 + dur - SALIDA);
      g.gain.linearRampToValueAtTime(0, t0 + dur);
    } else {
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      g.gain.linearRampToValueAtTime(0, t0 + dur + 0.005);
    }
    o.connect(g).connect(salida);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  const SONIDOS = {
    // Fallo: el "bu-buh" grave de dos notas de los menus de GB.
    error() {
      nota({ f: NOTAS.Eb4, dur: 0.09, ciclo: 0.25, vol: 0.3, forma: "plana" });
      nota({ t: 0.11, f: NOTAS.Bb3, dur: 0.2, ciclo: 0.25, vol: 0.3, forma: "plana" });
    },
    // Linea terminada: arpegio Do-Mi-Sol-Do de "objeto conseguido", con eco en el segundo canal.
    fin() {
      const arpegio = [NOTAS.C5, NOTAS.E5, NOTAS.G5, NOTAS.C6];
      arpegio.forEach((f, i) => {
        const ultima = i === arpegio.length - 1;
        nota({ t: i * 0.065, f, dur: ultima ? 0.3 : 0.065, ciclo: 0.5, vol: 0.3, forma: ultima ? "golpe" : "plana" });
        nota({ t: i * 0.065 + 0.035, f: f / 2, dur: ultima ? 0.26 : 0.055, ciclo: 0.125, vol: 0.12, forma: ultima ? "golpe" : "plana" });
      });
    },
  };

  return {
    sonar(tipo) {
      SONIDOS[tipo]?.();
    },
    tipos: Object.keys(SONIDOS),
  };
}

let motor = null;
let contexto = null;

/** Suena un efecto en el altavoz. El contexto se crea al primer uso (tras un clic del usuario). */
export function sonar(tipo) {
  try {
    if (!contexto) {
      contexto = new AudioContext();
      motor = crearMotor(contexto);
    }
    if (contexto.state === "suspended") contexto.resume();
    motor.sonar(tipo);
  } catch {
    /* sin audio disponible: se sigue sin sonido */
  }
}
