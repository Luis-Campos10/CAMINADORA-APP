// Motor de progresion automatica -- implementa las reglas que ya estaban
// escritas (pero sin automatizar) en plan_semanal.json -> "progresion.notas":
//   1. "4x4: si se domina con facilidad varias semanas, subir inclinacion
//      +1 antes que velocidad (protege rodillas)."
//   2. "Sprints: aumentar repeticiones a 8-10 antes de alargar la duracion
//      del sprint."
//   3. "Cada 4 semanas, comparar la FC promedio en zona 2 a la misma
//      velocidad (si baja, va bien)" -- esta es solo informativa, no
//      cambia el plan.
//
// Se ejecuta automaticamente al terminar cada sesion (ver app.js). No pide
// confirmacion (decision del usuario, 2026-08-20), pero registra cada
// cambio en un log (ver listarCambiosAutomaticos) para que quede visible
// que se cambio y por que.

const CLAVE_CAMBIOS = 'caminadora_cambios_automaticos';
const CLAVE_ESTADO = 'caminadora_progreso_estado';

const VENTANA_SESIONES_4X4 = 4;
const VENTANA_SESIONES_SPRINTS = 3;
const MAX_REPETICIONES_SPRINT = 10;
const MAX_INCLINACION = 15;

export function listarCambiosAutomaticos() {
  const raw = localStorage.getItem(CLAVE_CAMBIOS);
  return raw ? JSON.parse(raw) : [];
}

// Llamar cuando se restaura el plan por defecto -- si no, el sistema de
// progresion queda pensando que ya aplico cambios recientes sobre un plan
// que en realidad volvio a cero.
export function reiniciarProgreso() {
  localStorage.removeItem(CLAVE_CAMBIOS);
  localStorage.removeItem(CLAVE_ESTADO);
}

function registrarCambio(descripcion) {
  const cambios = listarCambiosAutomaticos();
  cambios.push({ fecha: new Date().toISOString().slice(0, 10), descripcion });
  localStorage.setItem(CLAVE_CAMBIOS, JSON.stringify(cambios));
}

function cargarEstado() {
  const raw = localStorage.getItem(CLAVE_ESTADO);
  return raw ? JSON.parse(raw) : {};
}

function guardarEstado(estado) {
  localStorage.setItem(CLAVE_ESTADO, JSON.stringify(estado));
}

// Recorre bloques (incluyendo los que estan dentro de grupos {repetir,
// bloques}) y devuelve referencias DIRECTAS a los que matchean la zona,
// para poder mutarlos en el lugar.
function bloquesDeZona(bloquesRaw, zona) {
  const resultado = [];
  for (const item of bloquesRaw) {
    if ('repetir' in item) {
      for (const sub of item.bloques) if (sub.zona === zona) resultado.push(sub);
    } else if (item.zona === zona) {
      resultado.push(item);
    }
  }
  return resultado;
}

function sesionesRecientesDia(sesiones, diaPlan, cantidad) {
  return sesiones
    .filter((s) => s.diaPlan === diaPlan)
    .sort((a, b) => b.id - a.id)
    .slice(0, cantidad);
}

// --- Regla 1: 4x4 dominado -> subir inclinacion --------------------------

function evaluarRegla4x4(plan, sesiones, estado) {
  const diaCfg = plan.dias.miercoles;
  if (!diaCfg || diaCfg.tipo !== 'fijo') return null;
  const bloquesVo2max = bloquesDeZona(diaCfg.bloques, 'vo2max');
  if (!bloquesVo2max.length) return null;
  const fcObjetivoMin = bloquesVo2max[0].fc_objetivo_min;
  if (fcObjetivoMin == null) return null;
  if (bloquesVo2max[0].inclinacion_pct >= MAX_INCLINACION) return null;

  const desde = estado.ultimoCambio4x4Id || 0;
  const recientes = sesionesRecientesDia(sesiones, 'miercoles', VENTANA_SESIONES_4X4).filter(
    (s) => s.id > desde && !s.abortada && s.fc_por_bloque && s.fc_por_bloque.length,
  );
  if (recientes.length < VENTANA_SESIONES_4X4) return null;

  const dominado = recientes.every((s) => {
    const lecturas = s.fc_por_bloque.filter((b) => b.zona === 'vo2max');
    if (!lecturas.length) return false;
    const prom = lecturas.reduce((a, b) => a + b.fcPromedio, 0) / lecturas.length;
    return prom < fcObjetivoMin;
  });
  if (!dominado) return null;

  for (const b of bloquesVo2max) b.inclinacion_pct = Math.min(MAX_INCLINACION, b.inclinacion_pct + 1);
  estado.ultimoCambio4x4Id = recientes[0].id; // el mas reciente de la tanda usada
  return (
    `4x4 (miércoles): FC promedio por debajo de ${fcObjetivoMin} bpm en las últimas ` +
    `${VENTANA_SESIONES_4X4} sesiones -- inclinación de "Trabajo 4x4" subida a nivel ${bloquesVo2max[0].inclinacion_pct}.`
  );
}

// --- Regla 2: sprints completos -> subir repeticiones ---------------------

function evaluarReglaSprints(plan, sesiones, estado) {
  const diaCfg = plan.dias.viernes;
  if (!diaCfg || diaCfg.tipo !== 'fijo') return null;
  const grupoSprint = diaCfg.bloques.find(
    (item) => 'repetir' in item && item.bloques.some((b) => b.zona === 'sprint'),
  );
  if (!grupoSprint || grupoSprint.repetir >= MAX_REPETICIONES_SPRINT) return null;

  const desde = estado.ultimoCambioSprintsId || 0;
  const recientes = sesionesRecientesDia(sesiones, 'viernes', VENTANA_SESIONES_SPRINTS).filter((s) => s.id > desde);
  if (recientes.length < VENTANA_SESIONES_SPRINTS) return null;

  const todasCompletas = recientes.every((s) => !s.abortada && s.bloques_completados === s.bloques_totales);
  if (!todasCompletas) return null;

  grupoSprint.repetir += 1;
  estado.ultimoCambioSprintsId = recientes[0].id;
  return (
    `Sprints (viernes): últimas ${VENTANA_SESIONES_SPRINTS} sesiones completas sin abortar -- ` +
    `repeticiones subidas a ${grupoSprint.repetir}.`
  );
}

// --- Punto de entrada: correr despues de cada sesion guardada -------------

export function evaluarProgresion(plan, sesiones) {
  const estado = cargarEstado();
  const cambios = [];

  const msg4x4 = evaluarRegla4x4(plan, sesiones, estado);
  if (msg4x4) cambios.push(msg4x4);

  const msgSprints = evaluarReglaSprints(plan, sesiones, estado);
  if (msgSprints) cambios.push(msgSprints);

  if (cambios.length) {
    guardarEstado(estado);
    for (const c of cambios) registrarCambio(c);
  }
  return cambios;
}

// --- Insight informativo de zona 2 (no cambia el plan) --------------------

export function calcularInsightZona2(sesiones) {
  const puntos = sesiones
    .filter((s) => s.diaPlan === 'martes' && s.fc_por_bloque)
    .map((s) => {
      const lecturas = s.fc_por_bloque.filter((b) => b.zona === 'zona2');
      if (!lecturas.length) return null;
      const fcProm = lecturas.reduce((a, b) => a + b.fcPromedio, 0) / lecturas.length;
      const velProm = lecturas.reduce((a, b) => a + b.velocidad_kmh, 0) / lecturas.length;
      return { id: s.id, fecha: s.fecha, fcProm, velProm };
    })
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);

  if (puntos.length < 2) return null;

  const primero = puntos[0];
  const ultimo = puntos[puntos.length - 1];
  // Solo comparable si la velocidad de referencia es similar (misma carga).
  if (Math.abs(primero.velProm - ultimo.velProm) > 0.3) return null;

  const delta = Math.round((ultimo.fcProm - primero.fcProm) * 10) / 10;
  return {
    fechaInicial: primero.fecha,
    fechaFinal: ultimo.fecha,
    fcInicial: Math.round(primero.fcProm),
    fcActual: Math.round(ultimo.fcProm),
    delta,
    sesiones: puntos.length,
    mejora: delta < 0,
  };
}
