// Utilidades de UX para durante el entrenamiento: mantener la pantalla
// encendida (Wake Lock) y avisar con sonido/vibracion en transiciones de
// bloque, ya que no conviene tener que estar mirando el celular todo el
// tiempo mientras se camina/corre.

let wakeLock = null;
let sesionActivaParaWakeLock = false;

export async function pedirWakeLock() {
  sesionActivaParaWakeLock = true;
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (e) {
    console.warn('[AVISO] no se pudo mantener la pantalla encendida:', e);
  }
}

export async function liberarWakeLock() {
  sesionActivaParaWakeLock = false;
  if (wakeLock) {
    await wakeLock.release();
    wakeLock = null;
  }
}

// El sistema operativo libera el wake lock cuando la pestaña deja de estar
// visible (ej. se apaga la pantalla sola); hay que volver a pedirlo apenas
// se recupera la visibilidad si la sesion segue activa.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sesionActivaParaWakeLock && !wakeLock) {
    pedirWakeLock();
  }
});

// --- Sonido / vibracion --------------------------------------------------

let audioCtx = null;

function tono(frecuencia, duracionMs, retrasoMs = 0) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frecuencia;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const t0 = audioCtx.currentTime + retrasoMs / 1000;
    osc.start(t0);
    osc.stop(t0 + duracionMs / 1000);
  } catch (e) {
    // Web Audio puede fallar si el navegador todavia no tuvo un gesto del
    // usuario en esta pagina; no es critico, se ignora.
  }
}

export function avisarNuevoBloque() {
  if (navigator.vibrate) navigator.vibrate(200);
  tono(880, 150);
}

export function avisarSesionCompleta() {
  if (navigator.vibrate) navigator.vibrate([150, 100, 150, 100, 300]);
  tono(660, 150, 0);
  tono(880, 150, 200);
  tono(1046, 250, 400);
}
