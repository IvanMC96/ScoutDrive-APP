/**
 * ════════════════════════════════════════════════════════════════
 *  SCOUTDRIVE · PUENTE DE SINCRONIZACIÓN CON GOOGLE SHEETS
 * ════════════════════════════════════════════════════════════════
 *  Este archivo se carga con <script src="sync-bridge.js"> al final
 *  de tu index.html, justo antes de </body>. NUNCA se pega a mano
 *  dentro de tu HTML — así, si algo de este archivo fallara, jamás
 *  puede romper la sintaxis de tu app principal.
 *
 *  Qué hace:
 *  1. Después de que guardarJ()/guardarE() hagan su trabajo normal
 *     (guardar en jDB/eDB + localStorage, igual que siempre), manda
 *     una copia a tu Google Sheet en segundo plano, sin bloquear ni
 *     ralentizar el guardado que ya tenías.
 *  2. Si no hay conexión, encola el envío y lo reintenta solo cuando
 *     vuelve internet.
 *  3. Al abrir la app, pregunta al Sheet si hay jugadores/equipos
 *     nuevos (añadidos desde otro dispositivo, por ejemplo) y los
 *     trae a tu lista local automáticamente.
 *
 *  Qué NO hace:
 *  - No sustituye tu almacenamiento local. Sigues funcionando 100%
 *    offline igual que siempre; esto es un añadido por encima.
 *  - No modifica ninguna función tuya por dentro — solo "envuelve"
 *    guardarJ y guardarE para añadir un paso extra después.
 * ════════════════════════════════════════════════════════════════
 */

// ════════════════════════════════════════════════════════════════
//  CONFIGURACIÓN
// ════════════════════════════════════════════════════════════════
const SCOUT_API_URL = 'https://script.google.com/macros/s/AKfycbxhniCqW0myBdoQKno5UrJ48XhldlAs9upb09PG5dvQmF9CRZxXWwkI2rAEfhCf5Xz8/exec';

// Pon esto en false desde la consola si alguna vez quieres trabajar
// offline puro sin que intente conectar (vuelve a true al recargar).
let SCOUT_SYNC_ENABLED = true;

const SYNC_COLA_KEY = 'scout_cola_offline_v1';
const SYNC_META_KEY = 'scout_ultima_sync_v1';

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
function _scoutToast(msg, err) {
  if (typeof toast === 'function') toast(msg, !!err);
  else console.log('[Scoutdrive sync]', msg);
}

function _scoutCargarCola() {
  try { return JSON.parse(localStorage.getItem(SYNC_COLA_KEY) || '[]'); }
  catch (e) { return []; }
}
function _scoutGuardarCola(cola) {
  try { localStorage.setItem(SYNC_COLA_KEY, JSON.stringify(cola)); } catch (e) {}
}

// ════════════════════════════════════════════════════════════════
//  PETICIONES A LA WEB APP
// ════════════════════════════════════════════════════════════════
async function scoutApiPost(accion, datos) {
  if (!SCOUT_SYNC_ENABLED) return { ok: false, offline: true, motivo: 'Sync desactivada' };
  try {
    const res = await fetch(SCOUT_API_URL, {
      method: 'POST',
      // text/plain evita el preflight CORS que Apps Script no soporta bien
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ accion, datos }),
    });
    if (!res.ok) return { ok: false, offline: false, motivo: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { ok: false, offline: true, motivo: String(err) };
  }
}

async function scoutApiGet(params) {
  if (!SCOUT_SYNC_ENABLED) return { ok: false, offline: true };
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${SCOUT_API_URL}?${qs}`, { method: 'GET' });
    if (!res.ok) return { ok: false, offline: false, motivo: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { ok: false, offline: true, motivo: String(err) };
  }
}

// ════════════════════════════════════════════════════════════════
//  COLA OFFLINE — reintento automático
// ════════════════════════════════════════════════════════════════
function scoutEncolar(accion, datos) {
  const cola = _scoutCargarCola();
  cola.push({ accion, datos, intentos: 0, encolado: new Date().toISOString() });
  _scoutGuardarCola(cola);
  _scoutActualizarBadge(cola.length);
}

async function scoutProcesarCola() {
  const cola = _scoutCargarCola();
  if (!cola.length) return;

  const pendientes = [];
  for (const item of cola) {
    const resultado = await scoutApiPost(item.accion, item.datos);
    if (!resultado.ok) {
      item.intentos = (item.intentos || 0) + 1;
      if (item.intentos < 10) pendientes.push(item);
    }
  }
  _scoutGuardarCola(pendientes);
  _scoutActualizarBadge(pendientes.length);

  if (pendientes.length === 0 && cola.length > 0) {
    _scoutToast('☁️ Todo sincronizado con Google Sheets');
  }
}

// Pequeño indicador visual en la barra superior — no toca tu CSS,
// se crea solo y se actualiza solo.
function _scoutActualizarBadge(pendientesCount) {
  let badge = document.getElementById('scout-sync-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'scout-sync-badge';
    badge.style.cssText = `
      font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;
      margin-left:8px;display:none;cursor:default;white-space:nowrap;
    `;
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.appendChild(badge);
  }
  if (pendientesCount > 0) {
    badge.textContent = `☁️ ${pendientesCount} pendiente${pendientesCount !== 1 ? 's' : ''}`;
    badge.style.background = 'rgba(210,153,34,.15)';
    badge.style.color = '#e3b341';
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

window.addEventListener('online', () => {
  _scoutToast('🌐 Conexión recuperada, sincronizando...');
  scoutProcesarCola();
});
setInterval(scoutProcesarCola, 60000);

// ════════════════════════════════════════════════════════════════
//  ENGANCHE A guardarJ() / guardarE()
// ════════════════════════════════════════════════════════════════
//  Esperamos a que el DOM esté listo y las funciones originales ya
//  existan (las define tu script principal, que se carga ANTES que
//  este archivo) para poder envolverlas sin pisarlas.
// ════════════════════════════════════════════════════════════════
(function engancharGuardado() {
  if (typeof guardarJ !== 'function' || typeof guardarE !== 'function') {
    // Si por algún motivo este script se cargara antes de tiempo,
    // reintentamos en el siguiente tick en vez de fallar en silencio.
    setTimeout(engancharGuardado, 50);
    return;
  }

  const _guardarJ_original = guardarJ;
  guardarJ = function () {
    _guardarJ_original();
    const j = (typeof jDB !== 'undefined' && typeof jId !== 'undefined')
      ? jDB.find(x => x.id === jId) : null;
    if (j) scoutSincronizarJugador(j);
  };

  const _guardarE_original = guardarE;
  guardarE = function () {
    _guardarE_original();
    const eq = (typeof eDB !== 'undefined' && typeof eId !== 'undefined')
      ? eDB.find(x => x.id === eId) : null;
    if (eq) scoutSincronizarEquipo(eq);
  };

  console.log('[Scoutdrive sync] Conectado: guardarJ() y guardarE() ahora sincronizan con Google Sheets.');
})();

async function scoutSincronizarJugador(j) {
  const resultado = await scoutApiPost('guardarJugador', j);
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('guardarJugador', j);
  } else if (resultado.ok) {
    _scoutToast('☁️ Jugador sincronizado con Google Sheets');
    _scoutActualizarURLsImagen('jDB', j.id, resultado.resultado);
  } else {
    console.warn('[Scoutdrive sync] Error al sincronizar jugador:', resultado.motivo);
  }
}

async function scoutSincronizarEquipo(eq) {
  const resultado = await scoutApiPost('guardarEquipo', eq);
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('guardarEquipo', eq);
  } else if (resultado.ok) {
    _scoutToast('☁️ Equipo sincronizado con Google Sheets');
    _scoutActualizarURLsImagen('eDB', eq.id, resultado.resultado);
  } else {
    console.warn('[Scoutdrive sync] Error al sincronizar equipo:', resultado.motivo);
  }
}

/** Tras subir imágenes a Drive, el backend devuelve fotoURL/escudoURL.
 *  Sustituimos el base64 local por esa URL para que las próximas
 *  sincronizaciones sean más ligeras. */
function _scoutActualizarURLsImagen(arrayName, id, resultadoBackend) {
  if (!resultadoBackend) return;
  const arr = window[arrayName];
  if (!Array.isArray(arr)) return;
  const registro = arr.find(x => x.id === id);
  if (!registro) return;
  let cambiado = false;
  if (resultadoBackend.fotoURL && registro.imgJug && registro.imgJug.startsWith('data:')) {
    registro.imgJug = resultadoBackend.fotoURL; cambiado = true;
  }
  if (resultadoBackend.escudoURL && registro.imgEsc && registro.imgEsc.startsWith('data:')) {
    registro.imgEsc = resultadoBackend.escudoURL; cambiado = true;
  }
  if (cambiado) {
    if (arrayName === 'jDB' && typeof saveJDB === 'function') saveJDB();
    if (arrayName === 'eDB' && typeof saveEDB === 'function') saveEDB();
  }
}

// ════════════════════════════════════════════════════════════════
//  SINCRONIZACIÓN AL ABRIR LA APP
// ════════════════════════════════════════════════════════════════
async function scoutSincronizarAlAbrir() {
  if (!SCOUT_SYNC_ENABLED) return;
  if (typeof jDB === 'undefined' || typeof eDB === 'undefined') return;

  const ultimaSync = localStorage.getItem(SYNC_META_KEY) || '1970-01-01T00:00:00Z';
  const respuesta = await scoutApiGet({ accion: 'cambiosDesde', desde: ultimaSync });

  if (!respuesta.ok) return; // sin conexión al abrir, no pasa nada

  let huboNovedades = false;

  if (respuesta.jugadores && respuesta.jugadores.length) {
    respuesta.jugadores.forEach(remoto => {
      const idx = jDB.findIndex(x => x.id === remoto.id);
      const fechaLocal = idx >= 0 ? new Date(jDB[idx].fecha || 0).getTime() : 0;
      const fechaRemota = new Date(remoto.fechaActualizacion || 0).getTime();
      if (idx < 0) { jDB.unshift(remoto); huboNovedades = true; }
      else if (fechaRemota > fechaLocal) { jDB[idx] = remoto; huboNovedades = true; }
    });
  }
  if (respuesta.equipos && respuesta.equipos.length) {
    respuesta.equipos.forEach(remoto => {
      const idx = eDB.findIndex(x => x.id === remoto.id);
      const fechaLocal = idx >= 0 ? new Date(eDB[idx].fecha || 0).getTime() : 0;
      const fechaRemota = new Date(remoto.fechaActualizacion || 0).getTime();
      if (idx < 0) { eDB.unshift(remoto); huboNovedades = true; }
      else if (fechaRemota > fechaLocal) { eDB[idx] = remoto; huboNovedades = true; }
    });
  }

  localStorage.setItem(SYNC_META_KEY, respuesta.timestamp || new Date().toISOString());

  if (huboNovedades) {
    if (typeof saveJDB === 'function') saveJDB();
    if (typeof saveEDB === 'function') saveEDB();
    if (typeof currentSection !== 'undefined') {
      if (currentSection === 'jugadores-db' && typeof renderJDB === 'function') renderJDB();
      if (currentSection === 'equipos-db' && typeof renderEDB === 'function') renderEDB();
    }
    _scoutToast('☁️ Datos actualizados desde Google Sheets');
  }
}

// ════════════════════════════════════════════════════════════════
//  SINCRONIZACIÓN COMPLETA — trae TODO del Sheet
//  (útil al abrir desde un dispositivo nuevo)
// ════════════════════════════════════════════════════════════════
async function scoutSyncCompleto(silencioso) {
  if (!SCOUT_SYNC_ENABLED) return;

  const btn = document.getElementById('btn-sync-manual');
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

  const respuesta = await scoutApiGet({ accion: 'sync' });

  if (!respuesta.ok) {
    if (!silencioso) _scoutToast('Sin conexión con Google Sheets', true);
    if (btn) { btn.textContent = '🔄'; btn.disabled = false; }
    return;
  }

  let cambios = 0;

  if (respuesta.jugadores && respuesta.jugadores.length) {
    // Reconstruir desde jsonCompleto si existe
    const jugadoresReconstruidos = respuesta.jugadores.map(r => {
      if (r.jsonCompleto) {
        try { return { ...JSON.parse(r.jsonCompleto), _sincronizado: true }; }
        catch(e) {}
      }
      return r;
    });

    // Fusionar: si hay datos locales más nuevos, los conservamos
    jugadoresReconstruidos.forEach(remoto => {
      const idx = (typeof jDB !== 'undefined') ? jDB.findIndex(x => x.id === remoto.id) : -1;
      if (idx < 0) {
        if (typeof jDB !== 'undefined') { jDB.unshift(remoto); cambios++; }
      }
      // Si ya existe, el local tiene prioridad (puede tener cambios sin subir aún)
    });
  }

  if (respuesta.equipos && respuesta.equipos.length) {
    const equiposReconstruidos = respuesta.equipos.map(r => {
      if (r.jsonCompleto) {
        try { return { ...JSON.parse(r.jsonCompleto), _sincronizado: true }; }
        catch(e) {}
      }
      return r;
    });

    equiposReconstruidos.forEach(remoto => {
      const idx = (typeof eDB !== 'undefined') ? eDB.findIndex(x => x.id === remoto.id) : -1;
      if (idx < 0) {
        if (typeof eDB !== 'undefined') { eDB.unshift(remoto); cambios++; }
      }
    });
  }

  localStorage.setItem(SYNC_META_KEY, respuesta.timestamp || new Date().toISOString());

  if (cambios > 0) {
    if (typeof saveJDB === 'function') saveJDB();
    if (typeof saveEDB === 'function') saveEDB();
    if (typeof renderJDB === 'function') renderJDB();
    if (typeof renderEDB === 'function') renderEDB();
    _scoutToast(`☁️ ${cambios} elemento${cambios !== 1 ? 's' : ''} descargado${cambios !== 1 ? 's' : ''} del servidor`);
  } else {
    if (!silencioso) _scoutToast('✅ Todo actualizado');
  }

  if (btn) { btn.textContent = '🔄'; btn.disabled = false; }
}


document.addEventListener('DOMContentLoaded', () => {
  setTimeout(async () => {
    // Si el localStorage está vacío (dispositivo nuevo), traer todo del Sheet
    const tieneJugadores = localStorage.getItem('scout_j_v1');
    const tieneEquipos   = localStorage.getItem('scout_e_v1');
    const estaVacio = (!tieneJugadores || tieneJugadores === '[]') &&
                      (!tieneEquipos   || tieneEquipos   === '[]');

    if (estaVacio) {
      // Dispositivo nuevo: sync completo automático
      await scoutSyncCompleto(false);
    } else {
      // Dispositivo conocido: solo cambios recientes
      await scoutSincronizarAlAbrir();
    }
    await scoutProcesarCola();
  }, 1200);
});
