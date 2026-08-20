// Motor de entrenamiento -- puerto de motor_entrenamiento.py a JS.
// Arma la sesion del dia (expandiendo bloques repetidos) y la ejecuta
// bloque a bloque contra una instancia de CaminadoraBLE, emitiendo eventos
// para que la UI se actualice (nada de DOM aca adentro).

export const DIAS_ES = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];

// Sin comandos repetidos, la caminadora real corta la banda sola tras ~1 min
// de inactividad (confirmado 2026-08-19, ver docs/protocolo_caminadora.md).
const KEEPALIVE_MS = 10000;

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
  }

  _emit(tipo, detalle) {
    this.dispatchEvent(new CustomEvent(tipo, { detail: detalle }));
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
      // original del plan.
      if (performance.now() - ultimoKeepalive >= KEEPALIVE_MS) {
        await this.caminadora.setVelocidad(this._velocidadActual);
        await this.caminadora.setInclinacion(this._inclinacionActual);
        ultimoKeepalive = performance.now();
      }
      this._emit('tick', { restante, bloque, indice, total });
      await this._esperarSegundo();
      restante -= 1;
    }
    this._emit('bloque-fin', { bloque, indice, total });
    return true;
  }

  async ejecutarSesion(bloques) {
    this._abortar = false;
    this._pausado = false;
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

    await this.caminadora.detener();
    await this.caminadora.desconectar();

    const abortada = completados < bloques.length;
    this.estado = abortada ? EstadoSesion.ABORTADA : EstadoSesion.COMPLETA;

    const resultado = {
      bloques_completados: completados,
      bloques_totales: bloques.length,
      duracion_total_seg: duracionTotal,
      velocidad_promedio: velocidades.length ? velocidades.reduce((a, b) => a + b, 0) / velocidades.length : 0,
      inclinacion_promedio: inclinaciones.length ? inclinaciones.reduce((a, b) => a + b, 0) / inclinaciones.length : 0,
      abortada,
    };
    this._emit('sesion-fin', resultado);
    return resultado;
  }
}
