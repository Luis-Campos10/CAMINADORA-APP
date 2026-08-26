import { CaminadoraBLE } from './ble.js';
import {
  DIAS_ES,
  diaDeHoy,
  cargarPlan,
  guardarPlan,
  armarSesion,
  MotorEntrenamiento,
  EstadoSesion,
  guardarSesion,
  listarSesiones,
  borrarSesion,
} from './motor.js';
import { EditorPlan, renderEditorBloques } from './editor.js';
import { pedirWakeLock, liberarWakeLock, avisarNuevoBloque, avisarSesionCompleta } from './extras.js';
import { MonitorFC } from './hr.js';

const $ = (id) => document.getElementById(id);

const caminadora = new CaminadoraBLE();
const motor = new MotorEntrenamiento(caminadora);
const monitorFC = new MonitorFC();

let plan = null;
let diaSeleccionado = null;
let sesionArmada = null; // { nombre, bloques, variante }
let diaRealSesion = null;
let editor = null;

const CIRCUNFERENCIA_ANILLO = 2 * Math.PI * 98;
const MODO_DEBUG = new URLSearchParams(location.search).has('debug');
if (MODO_DEBUG) $('vista-debug').classList.remove('oculto');

// ---------------------------------------------------------------------------
// Soporte / registro de service worker
// ---------------------------------------------------------------------------

const SIN_SOPORTE_BLUETOOTH = !navigator.bluetooth;
if (SIN_SOPORTE_BLUETOOTH) {
  $('aviso-no-soportado').classList.remove('oculto');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

$('tab-entrenar').addEventListener('click', () => cambiarTab('entrenar'));
$('tab-historial').addEventListener('click', () => cambiarTab('historial'));
$('tab-editar').addEventListener('click', () => cambiarTab('editar'));

function cambiarTab(nombre) {
  $('vista-entrenar').classList.toggle('oculto', nombre !== 'entrenar');
  $('vista-historial').classList.toggle('oculto', nombre !== 'historial');
  $('vista-editar').classList.toggle('oculto', nombre !== 'editar');
  $('tab-entrenar').classList.toggle('activo', nombre === 'entrenar');
  $('tab-historial').classList.toggle('activo', nombre === 'historial');
  $('tab-editar').classList.toggle('activo', nombre === 'editar');
  if (nombre === 'historial') renderHistorial();
  if (nombre === 'editar') mostrarEditorDias();
}

// ---------------------------------------------------------------------------
// Conexion
// ---------------------------------------------------------------------------

caminadora.addEventListener('conectado', () => {
  $('punto-conexion').classList.add('conectado');
  $('texto-conexion').textContent = 'Conectada';
});

caminadora.addEventListener('desconectado', () => {
  $('punto-conexion').classList.remove('conectado');
  $('texto-conexion').textContent = 'Desconectada';
});

if (MODO_DEBUG) {
  caminadora.addEventListener('debug', (ev) => {
    const { dir, hex } = ev.detail;
    const linea = `[${new Date().toLocaleTimeString()}] ${dir}: ${hex}\n`;
    const log = $('debug-log');
    log.textContent += linea;
    log.scrollTop = log.scrollHeight;
  });
}

// ---------------------------------------------------------------------------
// Monitor de frecuencia cardiaca (reloj)
// ---------------------------------------------------------------------------

monitorFC.addEventListener('conectado', () => {
  $('punto-fc').classList.add('conectado');
  $('texto-fc').textContent = '-- bpm';
});

monitorFC.addEventListener('desconectado', () => {
  $('punto-fc').classList.remove('conectado', 'sin-contacto');
  $('texto-fc').textContent = '❤ Reloj';
});

monitorFC.addEventListener('fc', (ev) => {
  const { bpm, contacto } = ev.detail;
  $('texto-fc').textContent = `${bpm} bpm`;
  $('punto-fc').classList.toggle('sin-contacto', contacto === false);
});

$('btn-conectar-fc').addEventListener('click', async () => {
  if (SIN_SOPORTE_BLUETOOTH) {
    alert('Este navegador no soporta Web Bluetooth. Abri esta pagina en Chrome para Android.');
    return;
  }
  if (monitorFC.conectado) return; // ya conectado, el pill solo informa
  $('texto-fc').textContent = 'Conectando...';
  try {
    await monitorFC.conectar();
  } catch (e) {
    $('texto-fc').textContent = '❤ Reloj';
    alert(
      'No se pudo conectar con el reloj: ' + e.message +
      '\n\nRecorda activar en el reloj: Ajustes > Mas conexiones > ' +
      'Transmision de datos de frecuencia cardiaca, antes de conectar.',
    );
  }
});

// ---------------------------------------------------------------------------
// Seleccion de dia / variante
// ---------------------------------------------------------------------------

function nombreCortoDia(diaCfg) {
  if (diaCfg.tipo === 'externo') return diaCfg.nombre;
  if (diaCfg.tipo === 'variante_manual') return diaCfg.variantes.B.nombre;
  return diaCfg.nombre;
}

function mostrarPanelDias() {
  const hoy = diaDeHoy();
  const grid = $('grid-dias');
  grid.innerHTML = '';

  for (const dia of DIAS_ES) {
    const cfg = plan.dias[dia];
    const btn = document.createElement('button');
    btn.className = 'dia-btn' + (dia === hoy ? ' hoy' : '') + (cfg.tipo === 'externo' ? ' externo' : '');
    btn.innerHTML = `<span class="nombre-dia">${dia}${dia === hoy ? ' (hoy)' : ''}</span><span class="nombre-rutina">${nombreCortoDia(cfg)}</span>`;
    if (cfg.tipo === 'externo') {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => elegirDia(dia));
    }
    grid.appendChild(btn);
  }

  $('panel-dias').classList.remove('oculto');
  $('panel-variante').classList.add('oculto');
  $('panel-resumen').classList.add('oculto');
}

function elegirDia(dia) {
  diaSeleccionado = dia;
  const cfg = plan.dias[dia];

  if (cfg.tipo === 'variante_manual') {
    $('variante-prompt').textContent = cfg.prompt || `${dia}: elegi variante`;
    $('btn-variante-a').textContent = `A: ${cfg.variantes.A.nombre}`;
    $('btn-variante-b').textContent = `B: ${cfg.variantes.B.nombre}`;
    $('panel-dias').classList.add('oculto');
    $('panel-variante').classList.remove('oculto');
    return;
  }

  sesionArmada = armarSesion(plan, dia, null);
  mostrarResumen();
}

$('btn-variante-a').addEventListener('click', () => {
  sesionArmada = armarSesion(plan, diaSeleccionado, 'A');
  mostrarResumen();
});
$('btn-variante-b').addEventListener('click', () => {
  sesionArmada = armarSesion(plan, diaSeleccionado, 'B');
  mostrarResumen();
});
$('btn-variante-volver').addEventListener('click', mostrarPanelDias);
$('btn-resumen-volver').addEventListener('click', mostrarPanelDias);

function mostrarResumen() {
  $('panel-dias').classList.add('oculto');
  $('panel-variante').classList.add('oculto');

  if (!sesionArmada.bloques.length) {
    $('resumen-nombre').textContent = sesionArmada.nombre;
    $('resumen-detalle').textContent = 'Sesion externa / descanso -- nada para ejecutar en la caminadora.';
    $('btn-iniciar-sesion').classList.add('oculto');
  } else {
    const totalSeg = sesionArmada.bloques.reduce((a, b) => a + b.duracion_seg, 0);
    $('resumen-nombre').textContent = `${diaSeleccionado}: ${sesionArmada.nombre}`;
    $('resumen-detalle').textContent = `${sesionArmada.bloques.length} bloques, ${Math.round(totalSeg / 60)} min totales.`;
    $('btn-iniciar-sesion').classList.remove('oculto');
  }
  $('panel-resumen').classList.remove('oculto');
}

// ---------------------------------------------------------------------------
// Sesion en curso
// ---------------------------------------------------------------------------

$('btn-iniciar-sesion').addEventListener('click', async () => {
  if (SIN_SOPORTE_BLUETOOTH) {
    alert('Este navegador no soporta Web Bluetooth. Abri esta pagina en Chrome para Android.');
    return;
  }
  diaRealSesion = diaDeHoy();
  $('btn-iniciar-sesion').disabled = true;
  $('btn-iniciar-sesion').textContent = 'Conectando...';
  try {
    // ejecutarSesion() conecta la caminadora automaticamente si hace falta
    // (primera vez abre el selector de dispositivos Bluetooth del navegador).
    $('panel-resumen').classList.add('oculto');
    $('panel-sesion').classList.remove('oculto');
    $('btn-pausar').textContent = '⏸ Pausar';
    await pedirWakeLock();
    await motor.ejecutarSesion(sesionArmada.bloques);
  } catch (e) {
    alert('No se pudo conectar con la caminadora: ' + e.message);
    $('panel-sesion').classList.add('oculto');
    $('panel-resumen').classList.remove('oculto');
  } finally {
    await liberarWakeLock();
    $('btn-iniciar-sesion').disabled = false;
    $('btn-iniciar-sesion').textContent = 'Iniciar entrenamiento';
  }
});

motor.addEventListener('bloque-inicio', (ev) => {
  avisarNuevoBloque();
  const { bloque, indice, total } = ev.detail;
  $('sesion-bloque-nombre').textContent = bloque.nombre;
  $('sesion-velocidad').textContent = `${bloque.velocidad_kmh} km/h`;
  $('sesion-inclinacion').textContent = `${bloque.inclinacion_pct}`;
  $('sesion-progreso-texto').textContent = `bloque ${indice + 1}/${total}`;
  $('anillo-progreso').style.strokeDashoffset = `${CIRCUNFERENCIA_ANILLO}`;
  $('sesion-velocidad-real').textContent = 'real: --';
  $('sesion-inclinacion-real').textContent = 'real: --';

  const fcMin = bloque.fc_objetivo_min;
  const fcMax = bloque.fc_objetivo_max;
  const fcEl = $('sesion-fc');
  if (fcMin != null && fcMax != null) {
    fcEl.textContent = `FC objetivo: ${fcMin}-${fcMax} bpm`;
    fcEl.classList.remove('oculto');
  } else if (fcMax != null) {
    fcEl.textContent = `FC objetivo: hasta ${fcMax} bpm`;
    fcEl.classList.remove('oculto');
  } else {
    fcEl.classList.add('oculto');
  }
});

const anillo = $('anillo-progreso');
anillo.style.strokeDasharray = `${CIRCUNFERENCIA_ANILLO}`;

motor.addEventListener('tick', (ev) => {
  const { restante, bloque, indice, total } = ev.detail;
  const mins = Math.floor(restante / 60);
  const segs = restante % 60;
  $('sesion-countdown').textContent = `${String(mins).padStart(2, '0')}:${String(segs).padStart(2, '0')}`;

  const avanceBloque = (bloque.duracion_seg - restante) / bloque.duracion_seg;
  anillo.style.strokeDashoffset = `${CIRCUNFERENCIA_ANILLO * (1 - avanceBloque)}`;

  const progresoGlobal = ((indice + avanceBloque) / total) * 100;
  $('sesion-progreso-fill').style.width = `${progresoGlobal}%`;
});

motor.addEventListener('estado-sesion', (ev) => {
  $('btn-pausar').textContent = ev.detail.estado === EstadoSesion.PAUSADA ? '▶ Reanudar' : '⏸ Pausar';
});

motor.addEventListener('ajuste', (ev) => {
  $('sesion-velocidad').textContent = `${ev.detail.velocidad.toFixed(1)} km/h`;
  $('sesion-inclinacion').textContent = `${ev.detail.inclinacion}`;
});

motor.addEventListener('estado-real', (ev) => {
  const estado = ev.detail;
  $('sesion-velocidad-real').textContent = `real: ${estado.velocidadKmh.toFixed(1)} km/h${estado.enMarcha ? '' : ' (detenida)'}`;
  $('sesion-inclinacion-real').textContent = `real: ${estado.inclinacionNivel}`;
});

$('btn-vel-menos').addEventListener('click', () => motor.ajustarVelocidad(-0.5));
$('btn-vel-mas').addEventListener('click', () => motor.ajustarVelocidad(0.5));
$('btn-incl-menos').addEventListener('click', () => motor.ajustarInclinacion(-1));
$('btn-incl-mas').addEventListener('click', () => motor.ajustarInclinacion(1));

motor.addEventListener('sesion-fin', (ev) => {
  const r = ev.detail;
  if (!r.abortada) avisarSesionCompleta();
  guardarSesion(diaRealSesion, diaSeleccionado, sesionArmada.variante, r);

  $('panel-sesion').classList.add('oculto');
  $('resultado-titulo').textContent = r.abortada ? 'Sesion abortada' : 'Sesion completa 🎉';
  $('resultado-detalle').textContent =
    `${r.bloques_completados}/${r.bloques_totales} bloques, ${r.duracion_total_seg}s, ` +
    `v.prom=${r.velocidad_promedio.toFixed(2)} km/h, incl.prom=${r.inclinacion_promedio.toFixed(2)}`;
  $('panel-resultado').classList.remove('oculto');
});

$('btn-pausar').addEventListener('click', () => {
  if (motor.estado === EstadoSesion.PAUSADA) motor.reanudar();
  else motor.pausar();
});

$('btn-abortar').addEventListener('click', () => {
  if (confirm('¿Abortar la sesion actual?')) motor.abortar();
});

$('btn-resultado-volver').addEventListener('click', () => {
  $('panel-resultado').classList.add('oculto');
  mostrarPanelDias();
});

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------

function cambiarTabHistorial(nombre) {
  $('historial-vista-lista').classList.toggle('oculto', nombre !== 'lista');
  $('historial-vista-resumen').classList.toggle('oculto', nombre !== 'resumen');
  $('historial-tab-lista').classList.toggle('activo', nombre === 'lista');
  $('historial-tab-resumen').classList.toggle('activo', nombre === 'resumen');
}
$('historial-tab-lista').addEventListener('click', () => cambiarTabHistorial('lista'));
$('historial-tab-resumen').addEventListener('click', () => cambiarTabHistorial('resumen'));

function renderEstadisticasGenerales(sesiones) {
  const haceUnaSemana = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const totalMin = sesiones.reduce((acc, s) => acc + s.duracion_total_seg / 60, 0);
  const estaSemana = sesiones.filter((s) => new Date(s.fecha).getTime() >= haceUnaSemana).length;
  const completas = sesiones.filter((s) => !s.abortada).length;
  const porcentaje = sesiones.length ? Math.round((completas / sesiones.length) * 100) : 0;

  $('stat-total-sesiones').textContent = sesiones.length;
  $('stat-total-minutos').textContent = Math.round(totalMin);
  $('stat-semana').textContent = estaSemana;
  $('stat-completadas').textContent = sesiones.length ? `${porcentaje}%` : '--';
}

function renderListaHistorial(sesiones) {
  $('historial-vacio').classList.toggle('oculto', sesiones.length > 0);
  const tbody = $('tbody-historial');
  tbody.innerHTML = '';
  for (const s of sesiones) {
    const tr = document.createElement('tr');
    const mins = (s.duracion_total_seg / 60).toFixed(1);
    tr.innerHTML = `
      <td>${s.fecha}</td>
      <td>${s.diaPlan}${s.variante ? ' (' + s.variante + ')' : ''}</td>
      <td>${s.bloques_completados}/${s.bloques_totales}</td>
      <td>${mins}</td>
      <td>${s.abortada ? 'abortada' : 'completa'}</td>
      <td><button class="secundario boton-mini btn-borrar-sesion" data-id="${s.id}">✕</button></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('.btn-borrar-sesion').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm('¿Borrar esta sesion del historial?')) return;
      borrarSesion(Number(btn.dataset.id));
      renderHistorial();
    });
  });
}

function renderResumenHistorial(sesiones) {
  $('resumen-vacio').classList.toggle('oculto', sesiones.length > 0);
  const porRutina = new Map();
  for (const s of sesiones) {
    if (!porRutina.has(s.diaPlan)) porRutina.set(s.diaPlan, []);
    porRutina.get(s.diaPlan).push(s);
  }
  const tbody = $('tbody-resumen');
  tbody.innerHTML = '';
  const filas = [...porRutina.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [rutina, lista] of filas) {
    const completas = lista.filter((s) => !s.abortada).length;
    const minProm = lista.reduce((acc, s) => acc + s.duracion_total_seg / 60, 0) / lista.length;
    const velProm = lista.reduce((acc, s) => acc + s.velocidad_promedio, 0) / lista.length;
    const inclProm = lista.reduce((acc, s) => acc + s.inclinacion_promedio, 0) / lista.length;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${rutina}</td>
      <td>${lista.length}</td>
      <td>${completas}</td>
      <td>${minProm.toFixed(1)}</td>
      <td>${velProm.toFixed(2)}</td>
      <td>${inclProm.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderHistorial() {
  const sesiones = listarSesiones().slice().reverse();
  renderEstadisticasGenerales(sesiones);
  renderListaHistorial(sesiones);
  renderResumenHistorial(sesiones);
}

// ---------------------------------------------------------------------------
// Editor de plan
// ---------------------------------------------------------------------------

function mostrarEditorDias() {
  editor.diaActivo = null;
  $('editor-panel-dias').classList.remove('oculto');
  $('editor-panel-bloques').classList.add('oculto');
  editor.renderListaDias($('editor-grid-dias'), () => {
    $('editor-panel-dias').classList.add('oculto');
    $('editor-panel-bloques').classList.remove('oculto');
    refrescarEditorBloques();
  });
}

function refrescarEditorBloques() {
  const cfg = editor.plan.dias[editor.diaActivo];
  if (cfg.tipo === 'variante_manual') {
    $('editor-variantes').classList.remove('oculto');
    $('editor-btn-variante-a').textContent = `A: ${cfg.variantes.A.nombre}`;
    $('editor-btn-variante-b').textContent = `B: ${cfg.variantes.B.nombre}`;
    $('editor-btn-variante-a').classList.toggle('primario', editor.varianteActiva === 'A');
    $('editor-btn-variante-b').classList.toggle('primario', editor.varianteActiva === 'B');
  } else {
    $('editor-variantes').classList.add('oculto');
  }
  $('editor-acciones-agregar').classList.toggle('oculto', cfg.tipo === 'externo');
  renderEditorBloques($('editor-campos-bloques'), editor, refrescarEditorBloques);
}

$('btn-editor-volver').addEventListener('click', mostrarEditorDias);

$('btn-exportar-plan').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `plan_semanal_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

$('btn-importar-plan').addEventListener('click', () => {
  $('input-importar-plan').click();
});

$('input-importar-plan').addEventListener('change', async (ev) => {
  const archivo = ev.target.files[0];
  if (!archivo) return;
  try {
    const texto = await archivo.text();
    const nuevoPlan = JSON.parse(texto);
    if (!nuevoPlan.dias) throw new Error('el archivo no tiene el formato esperado (falta "dias")');
    plan = nuevoPlan;
    guardarPlan(plan);
    editor = new EditorPlan(plan);
    alert('Plan importado correctamente.');
    mostrarEditorDias();
  } catch (e) {
    alert('No se pudo importar el plan: ' + e.message);
  } finally {
    ev.target.value = '';
  }
});

$('editor-btn-variante-a').addEventListener('click', () => {
  editor.cambiarVariante('A');
  refrescarEditorBloques();
});
$('editor-btn-variante-b').addEventListener('click', () => {
  editor.cambiarVariante('B');
  refrescarEditorBloques();
});

$('btn-agregar-bloque').addEventListener('click', () => {
  editor.agregarBloque();
  refrescarEditorBloques();
});
$('btn-agregar-grupo').addEventListener('click', () => {
  editor.agregarGrupoRepetido();
  refrescarEditorBloques();
});

$('btn-guardar-plan').addEventListener('click', () => {
  editor.guardarCambios();
  plan = editor.plan; // mismo objeto, pero por si acaso se resincroniza
  alert('Cambios guardados.');
  mostrarEditorDias();
});

$('btn-restaurar-plan').addEventListener('click', async () => {
  if (!confirm('¿Restaurar el plan original? Se pierden todos los cambios que hiciste.')) return;
  plan = await editor.restaurarPorDefecto();
  mostrarEditorDias();
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

cargarPlan()
  .then((p) => {
    plan = p;
    editor = new EditorPlan(plan);
    mostrarPanelDias();
  })
  .catch((e) => {
    alert('No se pudo cargar plan_semanal.json: ' + e.message);
  });
