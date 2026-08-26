// Conexion al monitor de frecuencia cardiaca via Bluetooth SIG estandar
// (Heart Rate Service 0x180D / Heart Rate Measurement 0x2A37 con NOTIFY).
// Confirmado contra un Huawei Watch GT 5 Pro con "Transmision de datos de
// frecuencia cardiaca" activada en Ajustes > Mas conexiones (investigado
// con nRF Connect, 2026-08-20). A diferencia del protocolo de la
// caminadora, este es un servicio ESTANDAR documentado por Bluetooth SIG,
// no un protocolo propietario inferido.
//
// Formato de Heart Rate Measurement (Bluetooth SIG GATT spec):
//   byte 0 = flags
//     bit 0: 0 = BPM en UINT8, 1 = BPM en UINT16
//     bits 1-2: estado de contacto del sensor (2 = soportado pero no
//               detectado, 3 = soportado y detectado)
//   luego el valor de BPM (UINT8 o UINT16 segun el flag)
//   (energia gastada / RR-intervals opcionales, no se usan aca)

const SERVICE_HR = '0000180d-0000-1000-8000-00805f9b34fb';
const CHAR_HR_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';

const RECONEXION_INTENTOS = 5;
const RECONEXION_ESPERA_MS = 3000;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MonitorFC extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.bpmActual = null;
    this.contactoDetectado = null; // true / false / null (desconocido)
    this._reconectando = false;
    this._desconexionManual = false;
  }

  get conectado() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected);
  }

  _emit(tipo, detalle) {
    this.dispatchEvent(new CustomEvent(tipo, { detail: detalle }));
  }

  async conectar() {
    this._desconexionManual = false;
    if (!this.device) {
      // Requiere gesto del usuario (click) -- no llamar automaticamente.
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_HR] }],
        optionalServices: [SERVICE_HR],
      });
      this.device.addEventListener('gattserverdisconnected', () => this._onGattDesconectado());
    }
    await this._conectarGatt();
  }

  async _conectarGatt() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_HR);
    const characteristic = await service.getCharacteristic(CHAR_HR_MEASUREMENT);
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', (ev) => this._onNotify(ev));
    this._emit('conectado', {});
  }

  _onGattDesconectado() {
    this._emit('desconectado', {});
    if (this._desconexionManual || this._reconectando) return;
    this._reconectarSolo();
  }

  // Sin comandos repetidos ni intervencion, el reloj (como la caminadora)
  // puede perder el enlace BLE solo. Reintenta en segundo plano sin pedirle
  // nada al usuario (no hace falta el picker de nuevo, ya tenemos el
  // dispositivo elegido).
  async _reconectarSolo() {
    this._reconectando = true;
    this._emit('reconectando', {});
    for (let intento = 1; intento <= RECONEXION_INTENTOS; intento++) {
      await esperar(RECONEXION_ESPERA_MS);
      try {
        await this._conectarGatt();
        this._reconectando = false;
        return;
      } catch (e) {
        // sigue intentando
      }
    }
    this._reconectando = false;
    this._emit('reconexion-fallida', {});
  }

  async desconectar() {
    this._desconexionManual = true;
    if (this.conectado) this.device.gatt.disconnect();
  }

  _onNotify(event) {
    const dv = event.target.value;
    const flags = dv.getUint8(0);
    const formatoUint16 = (flags & 0x01) !== 0;
    const estadoContacto = (flags >> 1) & 0x03;

    let offset = 1;
    let bpm;
    if (formatoUint16) {
      bpm = dv.getUint16(offset, true);
      offset += 2;
    } else {
      bpm = dv.getUint8(offset);
      offset += 1;
    }

    this.bpmActual = bpm;
    this.contactoDetectado = estadoContacto === 3 ? true : estadoContacto === 2 ? false : null;
    this._emit('fc', { bpm: this.bpmActual, contacto: this.contactoDetectado });
  }
}
