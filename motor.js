// Motor de entrenamiento -- puerto de motor_entrenamiento.py a JS.
// Arma la sesion del dia (expandiendo bloques repetidos) y la ejecuta
// bloque a bloque contra una instancia de CaminadoraBLE, emitiendo eventos
// para que la UI se actualice (nada de DOM aca adentro).

export const DIAS_ES = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];

// Sin comandos repetidos, la caminadora real corta la banda sola tras ~1 min
// de inactividad (confirmado 2026-08-19, ver docs/protocolo_caminadora.md).
const KEEPALIVE_MS = 10000;

// Auto-ajuste de velocidad segun FC (opt-in por sesion). Parametros basados
// en evidencia de cinetica de FC durante ejercicio (tau ~18-70s segun nivel
// de entrenamiento; ver docs/protocolo_caminadora.md o el chat del
// 2026-08-20 para las fuentes). No es un controlador LTI calibrado por
// persona (séria overkill para esto) -- es un ajuste discreto conservador
// con zona muerta y cooldown informados por esa cinetica.
const FC_VENTANA_TAMANO = 8; // lecturas recientes para el promedio movil
const FC_SIGNAL_STALE_MS = 15000; // sin lectura nueva en este tiempo = señal perdida
const FC_GRACIA_INICIO_MS = 90000; // no ajustar en los primeros 90s del bloque (FC no estabilizada)
const FC_COOLDOWN_MS = 45000; // minimo entre ajustes automaticos normales
const FC_DEADBAND_BPM = 4; // margen fuera de la zona objetivo antes de actuar
const FC_MARGEN_SEGURIDAD_BPM = 8; // por encima de esto, reducir YA (bypass gracia/cooldown)
const FC_PASO_KMH = 0.5;
const FC_MAX_DERIVA_KMH = 2.0; // no alejarse mas de esto del valor original del bloque (no aplica a la reduccion de seguridad)

export function diaDeHoy() {
  // getDay(): 0=domingo..6=sabado -> reindexar a nuestro orden lunes..domingo
  const idx = (new Date().getDay() + 6) % 7;
  return DIAS_ES[idx];
}

export function expandirBloques(bloquesRaw) {
  const resultado = [];
  for (const item of bloquesRaw) {
    if ('repetir' in item) {
      for (let i = 0; i < item.repetir; i++) resultado.push(...item.bloques);
    } else {
      resultado.push(item);
    }
  }
  return resultado;
}

export function armarSesion(plan, diaNombre, varianteForzada) {
  const diaCfg = plan.dias[diaNombre];
  if (!diaCfg) throw new Error(`Dia '${diaNombre}' no existe en plan_semanal.json`);

  if (diaCfg.tipo === 'externo') {
    return { nombre: diaCfg.nombre, bloques: [], variante: null, externo: true };
  }

  if (diaCfg.tipo === 'variante_manual') {
    const letra = (varianteForzada || 'A').toUpperCase();
    const cfg = diaCfg.variantes[letra] ? diaCfg.variantes[letra] : diaCfg.variantes.A;
    const letraReal = diaCfg.variantes[letra] ? letra : 'A';
    return { nombre: cfg.nombre, bloques: expandirBloques(cfg.bloques), variante: letraReal };
  }

  if (diaCfg.tipo === 'fijo') {
    return { nombre: diaCfg.nombre, bloques: expandirBloques(diaCfg.bloques), variante: null };
  }

  throw new Error(`Tipo de dia desconocido: ${diaCfg.tipo}`);
}

const CLAVE_PLAN = 'caminadora_plan';

async function cargarPlanPorDefecto() {
  const resp = await fetch('./plan_semanal.json');
  if (!resp.ok) throw new Error('No se pudo cargar plan_semanal.json');
  return resp.json();
}

// Carga el plan editable del usuario (localStorage). La primera vez que se
// abre la app no hay nada guardado todavia, asi que se usa el
// plan_semanal.json que viene con la app como semilla inicial.
export async function cargarPlan() {
  const guardado = localStorage.getItem(CLAVE_PLAN);
  if (guardado) return JSON.parse(guardado);
  const porDefecto = await cargarPlanPorDefecto();
  guardarPlan(porDefecto);
  return porDefecto;
}

export function guardarPlan(plan) {
  localStorage.setItem(CLAVE_PLAN, JSON.stringify(plan));
}

// Descarta los cambios del usuario y vuelve al plan_semanal.json original.
export async function restaurarPlanPorDefecto() {
  const porDefecto = await cargarPlanPorDefecto();
  guardarPlan(porDefecto);
  return porDefecto;
}

// ---------------------------------------------------------------------------
// Persistencia -- localStorage en vez de SQLite (equivalente a la tabla
// sesiones_entrenamiento de motor_entrenamiento.py).
// ---------------------------------------------------------------------------

const CLAVE_HISTORIAL = 'caminadora_sesiones';

export function listarSesiones() {
  const raw = localStorage.getItem(CLAVE_HISTORIAL);
  return raw ? JSON.parse(raw) : [];
}

export function guardarSesion(diaReal, diaPlan, variante, resultado) {
  const sesiones = listarSesiones();
  sesiones.push({
    id: Date.now(),
    fecha: new Date().toISOString().slice(0, 10),
    diaReal,
    diaPlan,
    variante,
    ...resultado,
    creadoEn: new Date().toISOString(),
  });
  localStorage.setItem(CLAVE_HISTORIAL, JSON.stringify(sesiones));
}

export function borrarSesion(id) {
  const sesiones = listarSesiones().filter((s) => s.id !== id);
  localStorage.setItem(CLAVE_HISTORIAL, JSON.stringify(sesiones));
}

// ---------------------------------------------------------------------------
// Ejecucion de la sesion
// ---------------------------------------------------------------------------

export const EstadoSesion = Object.freeze({
  CORRIENDO: 'corriendo',
  PAUSADA: 'pausada',
  ABORTADA: 'abortada',
  COMPLETA: 'completa',
});

export class MotorEntrenamiento extends EventTarget {
  constructor(caminadora) {
    super();
    this.caminadora = caminadora;
    this.estado = null; // EstadoSesion
    this._abortar = false;
    this._pausado = false;

    this._autoFC = false;
    this._ventanaFC = [];
    this._fcUltimaLecturaTs = 0;
    this._bloqueInicioTs = 0;
    this._ultimoAjusteFCTs = 0;
    this._velocidadBaseBloque = 0;
    this._fcAcumuladorBloque = null; // null = no acumular (fuera de un bloque)
    this._resumenFCBloques = []; // [{ nombre, zona, velocidad_kmh, fcPromedio }] de la sesion actual
  }

  _emit(tipo, detalle) {
    this.dispatchEvent(new CustomEvent(tipo, { detail: detalle }));
  }

  // --- Auto-ajuste por FC --------------------------------------------------

  activarAutoFC(activo) {
    this._autoFC = activo;
  }

  // Llamar cada vez que llega una lectura nueva del monitor de FC (ver hr.js).
  // Seguro llamarlo aunque no haya sesion corriendo o autoFC este apagado --
  // se registra igual para el resumen de FC por bloque (usado por
  // progreso.js), independiente de si el auto-ajuste esta activado.
  actualizarFC(bpm) {
    this._fcUltimaLecturaTs = performance.now();
    this._ventanaFC.push(bpm);
    if (this._ventanaFC.length > FC_VENTANA_TAMANO) this._ventanaFC.shift();
    if (this._fcAcumuladorBloque) this._fcAcumuladorBloque.push(bpm);
  }

  _fcPromedio() {
    if (!this._ventanaFC.length) return null;
    return this._ventanaFC.reduce((a, b) => a + b, 0) / this._ventanaFC.length;
  }

  _fcSenalValida() {
    return this._fcUltimaLecturaTs > 0 && performance.now() - this._fcUltimaLecturaTs < FC_SIGNAL_STALE_MS;
  }

  async _ajustarPorFC(delta, { ignorarDeriva = false } = {}) {
    if (!ignorarDeriva) {
      const objetivo = this._velocidadActual + delta;
      if (Math.abs(objetivo - this._velocidadBaseBloque) > FC_MAX_DERIVA_KMH) return;
    }
    await this.ajustarVelocidad(delta);
    this._ultimoAjusteFCTs = performance.now();
  }

  async _evaluarAutoFC(bloque) {
    const tieneObjetivo = bloque.fc_objetivo_min != null || bloque.fc_objetivo_max != null;
    if (!tieneObjetivo) return;

    if (!this._fcSenalValida()) {
      this._emit('fc-auto-estado', { estado: 'sin-señal', fcProm: null });
      return;
    }

    const fcProm = this._fcPromedio();
    if (fcProm == null) return;
    const { fc_objetivo_min: min, fc_objetivo_max: max } = bloque;
    const ahora = performance.now();

    // Prioridad de seguridad: bien por encima del maximo, reducir ya,
    // sin esperar el "periodo de gracia" ni el cooldown normal, y sin
    // respetar el limite de deriva (la seguridad prima sobre seguir el plan).
    if (max != null && fcProm > max + FC_MARGEN_SEGURIDAD_BPM) {
      await this._ajustarPorFC(-FC_PASO_KMH, { ignorarDeriva: true });
      this._emit('fc-auto-estado', { estado: 'seguridad', fcProm });
      return;
    }

    if (ahora - this._bloqueInicioTs < FC_GRACIA_INICIO_MS) {
      this._emit('fc-auto-estado', { estado: 'estabilizando', fcProm });
      return;
    }
    if (ahora - this._ultimoAjusteFCTs < FC_COOLDOWN_MS) {
      this._emit('fc-auto-estado', { estado: 'esperando', fcProm });
      return;
    }

    if (max != null && fcProm > max + FC_DEADBAND_BPM) {
      await this._ajustarPorFC(-FC_PASO_KMH);
      this._emit('fc-auto-estado', { estado: 'bajando', fcProm });
    } else if (min != null && fcProm < min - FC_DEADBAND_BPM) {
      await this._ajustarPorFC(FC_PASO_KMH);
      this._emit('fc-auto-estado', { estado: 'subiendo', fcProm });
    } else {
      this._emit('fc-auto-estado', { estado: 'en-zona', fcProm });
    }
  }

  pausar() {
    if (this.estado !== EstadoSesion.CORRIENDO) return;
    this._pausado = true;
    this.estado = EstadoSesion.PAUSADA;
    this.caminadora.pausar();
    this._emit('estado-sesion', { estado: this.estado });
  }

  reanudar() {
    if (this.estado !== EstadoSesion.PAUSADA) return;
    this._pausado = false;
    this.estado = EstadoSesion.CORRIENDO;
    this.caminadora.iniciar();
    this._emit('estado-sesion', { estado: this.estado });
  }

  abortar() {
    this._abortar = true;
  }

  async _esperarSegundo() {
    return new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Ajuste manual del bloque en curso (ej. por FC): sube/baja la velocidad
  // u inclinacion respecto al valor programado del bloque, sin esperar a
  // que termine. El "latido" reenvia este valor ajustado, no el original
  // del plan, para no pisar el ajuste.
  async ajustarVelocidad(delta) {
    if (this.estado !== EstadoSesion.CORRIENDO) return;
    this._velocidadActual = Math.round((this._velocidadActual + delta) * 10) / 10;
    await this.caminadora.setVelocidad(this._velocidadActual);
    this._ultimoAjusteFCTs = performance.now(); // un ajuste (manual o por FC) reinicia el cooldown del auto-ajuste
    this._emit('ajuste', { velocidad: this._velocidadActual, inclinacion: this._inclinacionActual });
  }

  async ajustarInclinacion(delta) {
    if (this.estado !== EstadoSesion.CORRIENDO) return;
    this._inclinacionActual = this._inclinacionActual + delta;
    await this.caminadora.setInclinacion(this._inclinacionActual);
    this._emit('ajuste', { velocidad: this._velocidadActual, inclinacion: this._inclinacionActual });
  }

  async _ejecutarBloque(bloque, indice, total) {
    this._emit('bloque-inicio', { bloque, indice, total });

    // valores "en vivo" del bloque, arrancan en lo programado pero se
    // pueden ajustar manualmente durante el bloque (ver ajustarVelocidad).
    this._velocidadActual = bloque.velocidad_kmh;
    this._inclinacionActual = bloque.inclinacion_pct;
    this._velocidadBaseBloque = bloque.velocidad_kmh;
    this._ventanaFC = [];
    this._fcAcumuladorBloque = [];
    this._bloqueInicioTs = performance.now();
    this._ultimoAjusteFCTs = performance.now();
    await this.caminadora.setVelocidad(this._velocidadActual);
    await this.caminadora.setInclinacion(this._inclinacionActual);

    let restante = bloque.duracion_seg;
    let ultimoKeepalive = performance.now();
    while (restante > 0) {
      if (this._abortar) return false;
      if (this._pausado) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      // Latido periodico: sin comandos repetidos la caminadora real corta
      // la banda sola tras ~1 min (ver docs/protocolo_caminadora.md).
      // Reenvia el valor ACTUAL (con ajustes manuales aplicados), no el
      // original del plan. Aprovecha el mismo intervalo para consultar el
      // estado real y mostrarlo en la UI junto al objetivo.
      if (performance.now() - ultimoKeepalive >= KEEPALIVE_MS) {
        await this.caminadora.setVelocidad(this._velocidadActual);
        await this.caminadora.setInclinacion(this._inclinacionActual);
        const estado = await this.caminadora.leerEstado();
        this._emit('estado-real', estado);
        ultimoKeepalive = performance.now();
      }
      if (this._autoFC) await this._evaluarAutoFC(bloque);
      this._emit('tick', { restante, bloque, indice, total });
      await this._esperarSegundo();
      restante -= 1;
    }
    if (this._fcAcumuladorBloque && this._fcAcumuladorBloque.length) {
      const fcPromedio = this._fcAcumuladorBloque.reduce((a, b) => a + b, 0) / this._fcAcumuladorBloque.length;
      this._resumenFCBloques.push({
        nombre: bloque.nombre,
        zona: bloque.zona,
        velocidad_kmh: bloque.velocidad_kmh,
        fcPromedio: Math.round(fcPromedio * 10) / 10,
      });
    }
    this._fcAcumuladorBloque = null;
    this._emit('bloque-fin', { bloque, indice, total });
    return true;
  }

  async ejecutarSesion(bloques) {
    this._abortar = false;
    this._pausado = false;
    this._resumenFCBloques = [];
    this.estado = EstadoSesion.CORRIENDO;

    await this.caminadora.conectar();
    await this.caminadora.iniciar();

    let completados = 0;
    const velocidades = [];
    const inclinaciones = [];
    let duracionTotal = 0;

    for (let i = 0; i < bloques.length; i++) {
      const bloque = bloques[i];
      const ok = await this._ejecutarBloque(bloque, i, bloques.length);
      velocidades.push(bloque.velocidad_kmh);
      inclinaciones.push(bloque.inclinacion_pct);
      if (!ok) break;
      completados += 1;
      duracionTotal += bloque.duracion_seg;
    }

    const abortada = completados < bloques.length;
    // Marcar la sesion como terminada ANTES de desconectar: la UI usa el
    // estado para distinguir una desconexion esperada (fin de sesion) de
    // una perdida real de conexion a mitad de entrenamiento.
    this.estado = abortada ? EstadoSesion.ABORTADA : EstadoSesion.COMPLETA;

    await this.caminadora.detener();
    await this.caminadora.desconectar();

    const resultado = {
      bloques_completados: completados,
      bloques_totales: bloques.length,
      duracion_total_seg: duracionTotal,
      velocidad_promedio: velocidades.length ? velocidades.reduce((a, b) => a + b, 0) / velocidades.length : 0,
      inclinacion_promedio: inclinaciones.length ? inclinaciones.reduce((a, b) => a + b, 0) / inclinaciones.length : 0,
      abortada,
      fc_por_bloque: this._resumenFCBloques,
    };
    this._emit('sesion-fin', resultado);
    return resultado;
  }
}
