// Control BLE de la caminadora via Web Bluetooth.
// Protocolo FitShow, validado contra hardware real el 2026-08-19
// (ver docs/protocolo_caminadora.md en el proyecto). Puerto de
// caminadora_ble.py a JavaScript -- misma logica, mismos limites de
// seguridad.

const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const CHAR_NOTIFY_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';
const CHAR_WRITE_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';

const CMD_STATUS = [0x02, 0x51];
const CMD_START = [0x02, 0x53, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00];
const CMD_STOP = [0x02, 0x53, 0x03];
const CMD_SET_VEL_INCL_PREFIJO = [0x02, 0x53, 0x02];

// Limites fisicos de la Centurfit 3.5HP.
export const VELOCIDAD_MIN_KMH = 1.0;
export const VELOCIDAD_MAX_KMH = 16.0;
export const INCLINACION_MIN_NIVEL = 0;
export const INCLINACION_MAX_NIVEL = 15;

// Rampa de seguridad: nunca mandar un salto grande de golpe (ver
// docs/protocolo_caminadora.md, "Prueba de estres" -- un salto directo a
// maximo apago la caminadora por proteccion la primera vez que se probo).
const PASO_MAX_VELOCIDAD_KMH = 1.0;
const PASO_MAX_INCLINACION = 3;
const ESPERA_ENTRE_PASOS_MS = 1500;

const RECONEXION_INTENTOS = 5;
const RECONEXION_ESPERA_MS = 3000;
const TIMEOUT_RESPUESTA_MS = 3000;

function checksum(cmdBytes) {
  let c = 0;
  for (let i = 1; i < cmdBytes.length; i++) c ^= cmdBytes[i]; // excluye el 0x02 inicial
  return c;
}

function enmarcar(cmdBytes) {
  return new Uint8Array([...cmdBytes, checksum(cmdBytes), 0x03]);
}

export function clampVelocidad(kmh) {
  const ajustada = Math.max(VELOCIDAD_MIN_KMH, Math.min(VELOCIDAD_MAX_KMH, kmh));
  if (ajustada !== kmh) console.warn(`[AVISO] velocidad ${kmh} fuera de rango, ajustada a ${ajustada}`);
  return ajustada;
}

export function clampInclinacion(nivel) {
  const ajustada = Math.max(INCLINACION_MIN_NIVEL, Math.min(INCLINACION_MAX_NIVEL, nivel));
  if (ajustada !== nivel) console.warn(`[AVISO] inclinacion ${nivel} fuera de rango, ajustada a ${ajustada}`);
  return ajustada;
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class EstadoCaminadora {
  constructor({ velocidadKmh = 0, inclinacionNivel = 0, tiempoSeg = 0, enMarcha = false } = {}) {
    this.velocidadKmh = velocidadKmh;
    this.inclinacionNivel = inclinacionNivel;
    this.tiempoSeg = tiempoSeg; // solo un byte en el protocolo, se resetea/desborda pasados los 255s
    this.enMarcha = enMarcha;
  }
}

// EventTarget para notificar cambios de estado/conexion a la UI sin acoplar
// esta clase a nada de DOM.
export class CaminadoraBLE extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.characteristicWrite = null;
    this.iniciado = false;
    this.velocidadObjetivo = 0;
    this.inclinacionObjetivo = 0;
    this.velocidadEnviada = 0;
    this.inclinacionEnviada = 0;
    this.ultimoEstado = new EstadoCaminadora();
  }

  get conectado() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected);
  }

  _emit(tipo, detalle) {
    this.dispatchEvent(new CustomEvent(tipo, { detail: detalle }));
  }

  async conectar() {
    if (!this.device) {
      // El picker de Web Bluetooth SIEMPRE requiere gesto del usuario (click);
      // esta llamada debe dispararse desde un boton, no automaticamente.
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'FS-' }, { services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });
      this.device.addEventListener('gattserverdisconnected', () => {
        this._emit('desconectado', {});
      });
    }

    let ultimoError = null;
    for (let intento = 1; intento <= RECONEXION_INTENTOS; intento++) {
      try {
        const server = await this.device.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        this.characteristicWrite = await service.getCharacteristic(CHAR_WRITE_UUID);
        const characteristicNotify = await service.getCharacteristic(CHAR_NOTIFY_UUID);
        await characteristicNotify.startNotifications();
        characteristicNotify.addEventListener('characteristicvaluechanged', (ev) => this._onNotify(ev));
        this._emit('conectado', {});
        return;
      } catch (e) {
        ultimoError = e;
        await esperar(RECONEXION_ESPERA_MS);
      }
    }
    throw new Error(`No se pudo conectar tras ${RECONEXION_INTENTOS} intentos: ${ultimoError}`);
  }

  async desconectar() {
    if (this.conectado) this.device.gatt.disconnect();
  }

  _hex(uint8arr) {
    return [...uint8arr].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  }

  async _escribir(cmdBytes) {
    const payload = enmarcar(cmdBytes);
    this._emit('debug', { dir: 'TX', hex: this._hex(payload) });
    try {
      if (!this.conectado) await this.conectar();
      await this.characteristicWrite.writeValueWithoutResponse(payload);
      this._emit('debug', { dir: 'TX-ok', hex: this._hex(payload) });
    } catch (e) {
      this._emit('debug', { dir: 'TX-error', hex: this._hex(payload) + ' :: ' + e });
      console.warn('[AVISO] conexion BLE perdida durante escritura, reconectando...', e);
      await this.conectar();
      await this.characteristicWrite.writeValueWithoutResponse(payload);
      this._emit('debug', { dir: 'TX-ok (tras reconectar)', hex: this._hex(payload) });
    }
  }

  _onNotify(event) {
    const dv = event.target.value; // DataView
    const len = dv.byteLength;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, len);
    this._emit('debug', { dir: 'RX', hex: this._hex(bytes) });
    if (len < 2 || dv.getUint8(0) !== 0x02) return;

    if (len === 17) {
      this.ultimoEstado = new EstadoCaminadora({
        velocidadKmh: dv.getUint8(3) / 10,
        inclinacionNivel: dv.getUint8(4),
        tiempoSeg: dv.getUint8(5),
        enMarcha: true,
      });
      this._emit('estado', this.ultimoEstado);
    } else if (len === 5 && dv.getUint8(2) === 0 && dv.getUint8(3) === 0x51) {
      this.ultimoEstado = new EstadoCaminadora({
        velocidadKmh: 0,
        inclinacionNivel: 0,
        tiempoSeg: this.ultimoEstado.tiempoSeg,
        enMarcha: false,
      });
      this._emit('estado', this.ultimoEstado);
    }

    if (this._resolverEspera) {
      this._resolverEspera();
      this._resolverEspera = null;
    }
  }

  async _enviarVelocidadInclinacion() {
    const velInicio = this.velocidadEnviada;
    const inclInicio = this.inclinacionEnviada;
    const velObj = this.velocidadObjetivo;
    const inclObj = this.inclinacionObjetivo;

    const pasos = Math.max(
      1,
      Math.ceil(Math.abs(velObj - velInicio) / PASO_MAX_VELOCIDAD_KMH),
      Math.ceil(Math.abs(inclObj - inclInicio) / PASO_MAX_INCLINACION),
    );

    for (let i = 1; i <= pasos; i++) {
      const vel = velInicio + ((velObj - velInicio) * i) / pasos;
      const incl = inclInicio + ((inclObj - inclInicio) * i) / pasos;
      const velDecimas = Math.round(vel * 10) & 0xff;
      const nivel = Math.round(incl) & 0xff;
      await this._escribir([...CMD_SET_VEL_INCL_PREFIJO, velDecimas, nivel]);
      this.velocidadEnviada = vel;
      this.inclinacionEnviada = incl;
      if (i < pasos) await esperar(ESPERA_ENTRE_PASOS_MS);
    }
  }

  async setVelocidad(kmh) {
    this.velocidadObjetivo = clampVelocidad(kmh);
    if (this.iniciado) await this._enviarVelocidadInclinacion();
  }

  async setInclinacion(nivel) {
    this.inclinacionObjetivo = clampInclinacion(nivel);
    if (this.iniciado) await this._enviarVelocidadInclinacion();
  }

  async iniciar() {
    if (!this.iniciado) {
      await this._escribir(CMD_START);
      this.iniciado = true;
    }
    await this._enviarVelocidadInclinacion();
  }

  async pausar() {
    // Sin comando de pausa nativo en este protocolo: frenar a velocidad 0
    // de golpe es la direccion segura (a diferencia de acelerar de golpe).
    await this._escribir([...CMD_SET_VEL_INCL_PREFIJO, 0, Math.round(this.inclinacionObjetivo) & 0xff]);
    this.velocidadEnviada = 0;
  }

  async detener() {
    await this._escribir(CMD_STOP);
    this.iniciado = false;
    this.velocidadObjetivo = 0;
    this.inclinacionObjetivo = 0;
    this.velocidadEnviada = 0;
    this.inclinacionEnviada = 0;
  }

  async leerEstado() {
    return new Promise(async (resolve) => {
      let resuelto = false;
      const terminar = () => {
        if (resuelto) return;
        resuelto = true;
        resolve(this.ultimoEstado);
      };
      this._resolverEspera = terminar;
      setTimeout(terminar, TIMEOUT_RESPUESTA_MS);
      await this._escribir(CMD_STATUS);
    });
  }
}
