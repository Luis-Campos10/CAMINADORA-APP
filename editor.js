// Editor de plan_semanal.json desde la app. Trabaja sobre una copia en
// memoria del dia/variante elegido y solo escribe a localStorage (via
// guardarPlan) cuando el usuario aprieta "Guardar cambios".

import { guardarPlan, restaurarPlanPorDefecto, DIAS_ES } from './motor.js';

const $ = (id) => document.getElementById(id);

function bloqueVacio() {
  return { nombre: 'Nuevo bloque', duracion_seg: 60, velocidad_kmh: 3.5, inclinacion_pct: 0, zona: 'zona2' };
}

export class EditorPlan {
  constructor(plan) {
    this.plan = plan;
    this.diaActivo = null;
    this.varianteActiva = null; // null si el dia es 'fijo'
    this.bloquesEdit = null; // copia de trabajo del array de bloques
    this.nombreEdit = '';
    this.notaEdit = '';
  }

  // --- Navegacion ---------------------------------------------------------

  renderListaDias(contenedor, onSeleccionar) {
    contenedor.innerHTML = '';
    for (const dia of DIAS_ES) {
      const cfg = this.plan.dias[dia];
      const btn = document.createElement('button');
      btn.className = 'dia-btn';
      const nombre = cfg.tipo === 'variante_manual' ? cfg.variantes.B.nombre : cfg.nombre;
      btn.innerHTML = `<span class="nombre-dia">${dia}</span><span class="nombre-rutina">${nombre}</span>`;
      btn.addEventListener('click', () => {
        this.abrirDia(dia);
        onSeleccionar();
      });
      contenedor.appendChild(btn);
    }
  }

  abrirDia(dia) {
    this.diaActivo = dia;
    const cfg = this.plan.dias[dia];
    if (cfg.tipo === 'variante_manual') {
      this.varianteActiva = 'A';
    } else {
      this.varianteActiva = null;
    }
    this._cargarCopiaDeTrabajo();
  }

  cambiarVariante(letra) {
    this.varianteActiva = letra;
    this._cargarCopiaDeTrabajo();
  }

  _cargarCopiaDeTrabajo() {
    const cfg = this.plan.dias[this.diaActivo];
    if (cfg.tipo === 'externo') {
      this.nombreEdit = cfg.nombre;
      this.notaEdit = cfg.nota || '';
      this.bloquesEdit = null;
    } else if (cfg.tipo === 'variante_manual') {
      const v = cfg.variantes[this.varianteActiva];
      this.nombreEdit = v.nombre;
      this.bloquesEdit = JSON.parse(JSON.stringify(v.bloques));
    } else {
      this.nombreEdit = cfg.nombre;
      this.bloquesEdit = JSON.parse(JSON.stringify(cfg.bloques));
    }
  }

  guardarCambios() {
    const cfg = this.plan.dias[this.diaActivo];
    if (cfg.tipo === 'externo') {
      cfg.nombre = this.nombreEdit;
      cfg.nota = this.notaEdit;
    } else if (cfg.tipo === 'variante_manual') {
      cfg.variantes[this.varianteActiva].nombre = this.nombreEdit;
      cfg.variantes[this.varianteActiva].bloques = this.bloquesEdit;
    } else {
      cfg.nombre = this.nombreEdit;
      cfg.bloques = this.bloquesEdit;
    }
    guardarPlan(this.plan);
  }

  async restaurarPorDefecto() {
    this.plan = await restaurarPlanPorDefecto();
    this.diaActivo = null;
  }

  // --- Edicion de bloques --------------------------------------------------

  agregarBloque() {
    this.bloquesEdit.push(bloqueVacio());
  }

  agregarGrupoRepetido() {
    this.bloquesEdit.push({ repetir: 2, bloques: [bloqueVacio(), bloqueVacio()] });
  }

  eliminarItem(indice) {
    this.bloquesEdit.splice(indice, 1);
  }

  moverItem(indice, delta) {
    const destino = indice + delta;
    if (destino < 0 || destino >= this.bloquesEdit.length) return;
    const [item] = this.bloquesEdit.splice(indice, 1);
    this.bloquesEdit.splice(destino, 0, item);
  }

  agregarSubBloque(indiceGrupo) {
    this.bloquesEdit[indiceGrupo].bloques.push(bloqueVacio());
  }

  eliminarSubBloque(indiceGrupo, indiceSub) {
    this.bloquesEdit[indiceGrupo].bloques.splice(indiceSub, 1);
  }
}

// ---------------------------------------------------------------------------
// Render de un formulario de bloque (reutilizado para bloques planos y para
// los sub-bloques de un grupo repetido)
// ---------------------------------------------------------------------------

function crearCampoBloque(bloque, onCambio) {
  const wrap = document.createElement('div');
  wrap.className = 'bloque-form';

  const fila1 = document.createElement('div');
  fila1.className = 'campo-fila';
  fila1.innerHTML = `<label>Nombre</label>`;
  const inputNombre = document.createElement('input');
  inputNombre.type = 'text';
  inputNombre.value = bloque.nombre || '';
  inputNombre.addEventListener('input', () => { bloque.nombre = inputNombre.value; onCambio(); });
  fila1.appendChild(inputNombre);
  wrap.appendChild(fila1);

  function campoNumero(etiqueta, clave, paso, min) {
    const fila = document.createElement('div');
    fila.className = 'campo-fila';
    fila.innerHTML = `<label>${etiqueta}</label>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = paso;
    if (min != null) input.min = min;
    input.value = bloque[clave] ?? '';
    input.addEventListener('input', () => {
      bloque[clave] = input.value === '' ? undefined : parseFloat(input.value);
      onCambio();
    });
    fila.appendChild(input);
    wrap.appendChild(fila);
  }

  campoNumero('Duracion (segundos)', 'duracion_seg', 5, 5);
  campoNumero('Velocidad (km/h)', 'velocidad_kmh', 0.5, 1);
  campoNumero('Inclinacion (nivel)', 'inclinacion_pct', 1, 0);
  campoNumero('FC objetivo min (opcional)', 'fc_objetivo_min', 1, 0);
  campoNumero('FC objetivo max (opcional)', 'fc_objetivo_max', 1, 0);

  const filaZona = document.createElement('div');
  filaZona.className = 'campo-fila';
  filaZona.innerHTML = `<label>Zona</label>`;
  const inputZona = document.createElement('input');
  inputZona.type = 'text';
  inputZona.value = bloque.zona || '';
  inputZona.addEventListener('input', () => { bloque.zona = inputZona.value; onCambio(); });
  filaZona.appendChild(inputZona);
  wrap.appendChild(filaZona);

  return wrap;
}

export function renderEditorBloques(contenedor, editor, refrescar) {
  contenedor.innerHTML = '';
  const cfg = editor.plan.dias[editor.diaActivo];

  if (cfg.tipo === 'externo') {
    const nombreInput = document.createElement('input');
    nombreInput.type = 'text';
    nombreInput.value = editor.nombreEdit;
    nombreInput.addEventListener('input', () => { editor.nombreEdit = nombreInput.value; });
    const notaInput = document.createElement('textarea');
    notaInput.value = editor.notaEdit;
    notaInput.rows = 3;
    notaInput.addEventListener('input', () => { editor.notaEdit = notaInput.value; });
    contenedor.appendChild(labelEnvuelto('Nombre', nombreInput));
    contenedor.appendChild(labelEnvuelto('Nota', notaInput));
    return;
  }

  const nombreInput = document.createElement('input');
  nombreInput.type = 'text';
  nombreInput.value = editor.nombreEdit;
  nombreInput.addEventListener('input', () => { editor.nombreEdit = nombreInput.value; });
  contenedor.appendChild(labelEnvuelto('Nombre de la rutina', nombreInput));

  editor.bloquesEdit.forEach((item, indice) => {
    const tarjeta = document.createElement('div');
    tarjeta.className = 'tarjeta-bloque';

    const cabecera = document.createElement('div');
    cabecera.className = 'cabecera-bloque';

    if ('repetir' in item) {
      cabecera.innerHTML = `<strong>Grupo repetido</strong>`;
      const inputVeces = document.createElement('input');
      inputVeces.type = 'number';
      inputVeces.min = 1;
      inputVeces.value = item.repetir;
      inputVeces.style.width = '60px';
      inputVeces.addEventListener('input', () => { item.repetir = parseInt(inputVeces.value, 10) || 1; });
      cabecera.appendChild(document.createTextNode(' x '));
      cabecera.appendChild(inputVeces);
      tarjeta.appendChild(cabecera);

      item.bloques.forEach((sub, indiceSub) => {
        const subTarjeta = document.createElement('div');
        subTarjeta.className = 'sub-bloque';
        const subCabecera = document.createElement('div');
        subCabecera.className = 'cabecera-bloque';
        subCabecera.innerHTML = `<span>Sub-bloque ${indiceSub + 1}</span>`;
        const btnBorrarSub = botonMini('✕', () => { editor.eliminarSubBloque(indice, indiceSub); refrescar(); });
        subCabecera.appendChild(btnBorrarSub);
        subTarjeta.appendChild(subCabecera);
        subTarjeta.appendChild(crearCampoBloque(sub, () => {}));
        tarjeta.appendChild(subTarjeta);
      });

      const btnAgregarSub = document.createElement('button');
      btnAgregarSub.className = 'secundario';
      btnAgregarSub.textContent = '+ Agregar sub-bloque';
      btnAgregarSub.style.width = '100%';
      btnAgregarSub.addEventListener('click', () => { editor.agregarSubBloque(indice); refrescar(); });
      tarjeta.appendChild(btnAgregarSub);
    } else {
      cabecera.innerHTML = `<strong>Bloque ${indice + 1}</strong>`;
      tarjeta.appendChild(cabecera);
      tarjeta.appendChild(crearCampoBloque(item, () => {}));
    }

    const controles = document.createElement('div');
    controles.className = 'controles-bloque';
    controles.appendChild(botonMini('↑', () => { editor.moverItem(indice, -1); refrescar(); }));
    controles.appendChild(botonMini('↓', () => { editor.moverItem(indice, 1); refrescar(); }));
    controles.appendChild(botonMini('🗑 Borrar', () => { editor.eliminarItem(indice); refrescar(); }));
    tarjeta.appendChild(controles);

    contenedor.appendChild(tarjeta);
  });
}

function labelEnvuelto(etiqueta, input) {
  const div = document.createElement('div');
  div.className = 'campo-fila';
  const label = document.createElement('label');
  label.textContent = etiqueta;
  div.appendChild(label);
  div.appendChild(input);
  return div;
}

function botonMini(texto, onClick) {
  const btn = document.createElement('button');
  btn.className = 'secundario boton-mini';
  btn.textContent = texto;
  btn.addEventListener('click', onClick);
  return btn;
}
