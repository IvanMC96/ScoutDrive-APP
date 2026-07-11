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
const SCOUT_API_URL = 'https://script.google.com/macros/s/AKfycbzd48VqvNICO6KhkFsCCKVQ3HzdAsco4hr4yUu4xYnhua-BMotf2Ra-AKlR7gMZdLNm/exec';

/** Convierte cualquier enlace de Drive (uc?export=view&id=..., file/d/.../view,
 *  open?id=...) al formato que Google SÍ deja insertar de forma fiable
 *  dentro de una etiqueta <img>. El formato "uc?export=view" que usaba
 *  antes el backend funciona al abrirlo directamente en el navegador,
 *  pero Google lo bloquea a menudo cuando se carga como imagen incrustada
 *  (por eso se veía bien en el Sheet pero no dentro de la app). */
function _driveURLViewable(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.includes('drive.google.com') && !url.includes('googleusercontent.com')) return url;
  const m = url.match(/[-\w]{25,}/);
  if (!m) return url;
  return `https://lh3.googleusercontent.com/d/${m[0]}=s0`;
}

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
    // Buscar el equipo recién guardado — puede estar en eDB o ser el actual eId
    const id = typeof eId !== 'undefined' ? eId : null;
    if (!id) return;
    const eq = (typeof eDB !== 'undefined') ? eDB.find(x => String(x.id) === String(id)) : null;
    if (eq) scoutSincronizarEquipo(eq);
    else console.warn('[Scoutdrive sync] Equipo no encontrado en eDB tras guardar:', id);
  };

  // guardarPartido / borrarPartido puede que aún no existan en este punto
  // (viven en el bloque de Partidos, más abajo en el archivo) — se
  // enganchan igual, más adelante, en engancharPartidos().
  console.log('[Scoutdrive sync] Conectado: guardarJ() y guardarE() ahora sincronizan con Google Sheets.');
})();

(function engancharPartidos() {
  if (typeof guardarPartido !== 'function' || typeof borrarPartido !== 'function') {
    setTimeout(engancharPartidos, 50);
    return;
  }

  const _guardarPartido_original = guardarPartido;
  guardarPartido = function () {
    const editIdAntes = document.getElementById('ap-edit-id') ? document.getElementById('ap-edit-id').value : '';
    _guardarPartido_original();
    const id = editIdAntes || (typeof pDB !== 'undefined' && pDB.length ? pDB[0].id : null);
    const p = (typeof pDB !== 'undefined') ? pDB.find(x => String(x.id) === String(id)) : null;
    if (p) scoutSincronizarPartidoVideo(p);
  };

  const _borrarPartido_original = borrarPartido;
  borrarPartido = function (id) {
    _borrarPartido_original(id);
    // Si se confirmó el borrado (el usuario aceptó el modal), pDB ya no
    // tendrá ese id. Lo mandamos a borrar también en el Sheet.
    setTimeout(() => {
      const sigueExistiendo = (typeof pDB !== 'undefined') && pDB.some(x => String(x.id) === String(id));
      if (!sigueExistiendo) scoutEliminarPartidoVideoRemoto(id);
    }, 300);
  };

  console.log('[Scoutdrive sync] Conectado: guardarPartido()/borrarPartido() ahora sincronizan con Google Sheets.');
})();

(function engancharAnuncios() {
  if (typeof guardarAnuncio !== 'function' || typeof borrarAnuncio !== 'function') {
    setTimeout(engancharAnuncios, 50);
    return;
  }

  const _guardarAnuncio_original = guardarAnuncio;
  guardarAnuncio = function () {
    const editIdAntes = document.getElementById('an-edit-id') ? document.getElementById('an-edit-id').value : '';
    _guardarAnuncio_original();
    const id = editIdAntes || (typeof adsDB !== 'undefined' && adsDB.length ? adsDB[0].id : null);
    const a = (typeof adsDB !== 'undefined') ? adsDB.find(x => String(x.id) === String(id)) : null;
    if (a) scoutSincronizarAnuncio(a);
  };

  const _borrarAnuncio_original = borrarAnuncio;
  borrarAnuncio = function (id) {
    _borrarAnuncio_original(id);
    setTimeout(() => {
      const sigueExistiendo = (typeof adsDB !== 'undefined') && adsDB.some(x => String(x.id) === String(id));
      if (!sigueExistiendo) scoutEliminarAnuncioRemoto(id);
    }, 300);
  };

  console.log('[Scoutdrive sync] Conectado: guardarAnuncio()/borrarAnuncio() ahora sincronizan con Google Sheets.');
})();

async function scoutSincronizarJugador(j) {
  const resultado = await scoutApiPost('guardarJugador', j);
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('guardarJugador', j);
  } else if (resultado.ok) {
    _scoutToast('☁️ Jugador sincronizado con Google Sheets');
    _scoutActualizarURLsImagen('jDB', j.id, resultado.resultado);
  } else {
    const detalle = resultado.motivo || resultado.error || 'error desconocido';
    console.warn('[Scoutdrive sync] Error al sincronizar jugador:', detalle);
    _scoutToast('⚠️ No se pudo subir el jugador al Sheet: ' + detalle, true);
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
    const detalle = resultado.motivo || resultado.error || 'error desconocido';
    console.warn('[Scoutdrive sync] Error al sincronizar equipo:', detalle);
    _scoutToast('⚠️ No se pudo subir el equipo al Sheet: ' + detalle, true);
  }
}

async function scoutSincronizarPartidoVideo(p) {
  const resultado = await scoutApiPost('guardarPartidoVideo', p);
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('guardarPartidoVideo', p);
  } else if (resultado.ok) {
    _scoutToast('☁️ Partido sincronizado con Google Sheets');
    if (resultado.resultado && resultado.resultado.thumbURL && typeof pDB !== 'undefined') {
      const idx = pDB.findIndex(x => x.id === p.id);
      if (idx >= 0 && resultado.resultado.thumbURL) {
        pDB[idx].thumb = _driveURLViewable(resultado.resultado.thumbURL);
        if (typeof savePDB === 'function') savePDB();
      }
    }
  } else {
    const detalle = resultado.motivo || resultado.error || 'error desconocido';
    console.warn('[Scoutdrive sync] Error al sincronizar partido:', detalle);
    _scoutToast('⚠️ No se pudo subir el partido al Sheet: ' + detalle, true);
  }
}

async function scoutEliminarPartidoVideoRemoto(id) {
  const resultado = await scoutApiPost('eliminarPartidoVideo', { id });
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('eliminarPartidoVideo', { id });
  } else if (!resultado.ok) {
    console.warn('[Scoutdrive sync] Error al eliminar partido en el Sheet:', resultado.motivo || resultado.error);
  }
}

async function scoutSincronizarAnuncio(a) {
  const resultado = await scoutApiPost('guardarAnuncio', a);
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('guardarAnuncio', a);
  } else if (resultado.ok) {
    _scoutToast('☁️ Anuncio sincronizado con Google Sheets');
    if (resultado.resultado && resultado.resultado.imgURL && typeof adsDB !== 'undefined') {
      const idx = adsDB.findIndex(x => x.id === a.id);
      if (idx >= 0) { adsDB[idx].img = _driveURLViewable(resultado.resultado.imgURL); if (typeof saveAds === 'function') saveAds(); }
    }
  } else {
    const detalle = resultado.motivo || resultado.error || 'error desconocido';
    console.warn('[Scoutdrive sync] Error al sincronizar anuncio:', detalle);
    _scoutToast('⚠️ No se pudo subir el anuncio al Sheet: ' + detalle, true);
  }
}

async function scoutEliminarAnuncioRemoto(id) {
  const resultado = await scoutApiPost('eliminarAnuncio', { id });
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('eliminarAnuncio', { id });
  } else if (!resultado.ok) {
    console.warn('[Scoutdrive sync] Error al eliminar anuncio en el Sheet:', resultado.motivo || resultado.error);
  }
}

// ════════════════════════════════════════════════════════════════
//  RESUBIDA MASIVA — útil una sola vez tras arreglar/cambiar el
//  backend, para subir todo lo que ya tienes guardado en local
//  (p.ej. en la tablet) y que quedó sin llegar nunca a la nube.
//  Sube uno a uno (sin solaparse) para no saturar Apps Script.
// ════════════════════════════════════════════════════════════════
async function scoutForzarResubidaTotal() {
  if (typeof jDB === 'undefined' || typeof eDB === 'undefined') return;
  const totalPartidos = (typeof pDB !== 'undefined') ? pDB.length : 0;
  const totalAds = (typeof adsDB !== 'undefined') ? adsDB.length : 0;
  const total = jDB.length + eDB.length + totalPartidos + totalAds;
  if (total === 0) { _scoutToast('No hay nada local que resubir', true); return; }

  const btn = document.getElementById('btn-resubida-total');
  if (btn) { btn.disabled = true; }

  let hechos = 0, fallos = 0;
  let primerError = '';

  for (const j of jDB) {
    if (btn) btn.textContent = `⏳ Subiendo jugadores... (${hechos + fallos + 1}/${total})`;
    const resultado = await scoutApiPost('guardarJugador', j);
    if (resultado.ok) { hechos++; _scoutActualizarURLsImagen('jDB', j.id, resultado.resultado); }
    else {
      fallos++;
      const detalle = resultado.motivo || resultado.error || 'error desconocido';
      if (!primerError) primerError = detalle;
      console.warn('[Scoutdrive] Fallo al resubir jugador', j.id, detalle);
    }
  }

  for (const eq of eDB) {
    if (btn) btn.textContent = `⏳ Subiendo equipos... (${hechos + fallos + 1}/${total})`;
    const resultado = await scoutApiPost('guardarEquipo', eq);
    if (resultado.ok) { hechos++; _scoutActualizarURLsImagen('eDB', eq.id, resultado.resultado); }
    else {
      fallos++;
      const detalle = resultado.motivo || resultado.error || 'error desconocido';
      if (!primerError) primerError = detalle;
      console.warn('[Scoutdrive] Fallo al resubir equipo', eq.id, detalle);
    }
  }

  if (typeof pDB !== 'undefined') {
    for (const p of pDB) {
      if (btn) btn.textContent = `⏳ Subiendo partidos... (${hechos + fallos + 1}/${total})`;
      const resultado = await scoutApiPost('guardarPartidoVideo', p);
      if (resultado.ok) {
        hechos++;
        if (resultado.resultado && resultado.resultado.thumbURL) p.thumb = _driveURLViewable(resultado.resultado.thumbURL);
      } else {
        fallos++;
        const detalle = resultado.motivo || resultado.error || 'error desconocido';
        if (!primerError) primerError = detalle;
        console.warn('[Scoutdrive] Fallo al resubir partido', p.id, detalle);
      }
    }
  }

  if (typeof adsDB !== 'undefined') {
    for (const a of adsDB) {
      if (btn) btn.textContent = `⏳ Subiendo publicidad... (${hechos + fallos + 1}/${total})`;
      const resultado = await scoutApiPost('guardarAnuncio', a);
      if (resultado.ok) {
        hechos++;
        if (resultado.resultado && resultado.resultado.imgURL) a.img = _driveURLViewable(resultado.resultado.imgURL);
      } else {
        fallos++;
        const detalle = resultado.motivo || resultado.error || 'error desconocido';
        if (!primerError) primerError = detalle;
        console.warn('[Scoutdrive] Fallo al resubir anuncio', a.id, detalle);
      }
    }
  }

  if (typeof saveJDB === 'function') saveJDB();
  if (typeof saveEDB === 'function') saveEDB();
  if (typeof savePDB === 'function') savePDB();
  if (typeof saveAds === 'function') saveAds();

  if (btn) { btn.disabled = false; btn.textContent = '☁️ Forzar resubida de todo lo local'; }

  if (fallos === 0) {
    _scoutToast(`✅ Resubida completa: ${hechos} elemento${hechos !== 1 ? 's' : ''} enviado${hechos !== 1 ? 's' : ''} al Sheet`);
  } else {
    _scoutToast(`⚠️ ${hechos} ok, ${fallos} con error. Motivo: ${primerError}`, true);
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
    registro.imgJug = _driveURLViewable(resultadoBackend.fotoURL); cambiado = true;
  }
  if (resultadoBackend.escudoURL && registro.imgEsc && registro.imgEsc.startsWith('data:')) {
    registro.imgEsc = _driveURLViewable(resultadoBackend.escudoURL); cambiado = true;
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
    respuesta.jugadores.forEach(r => {
      const remoto = _normalizarRegistro(r);
      if (!remoto.id) return;
      const idx = jDB.findIndex(x => x.id === remoto.id);
      const fechaLocal = idx >= 0 ? new Date(jDB[idx].fecha || 0).getTime() : 0;
      const fechaRemota = new Date(remoto.fechaActualizacion || 0).getTime();
      if (idx < 0) {
        // Registro que no existe en local todavía (p.ej. dispositivo nuevo):
        // lo añadimos siempre. No exigimos nombre aquí — si lo exigiéramos,
        // un fallo de mapeo de columnas en el Sheet dejaría el dispositivo
        // sin datos en vez de con datos "sin nombre" (que sí se pueden ver
        // y arreglar desde la app).
        jDB.unshift(remoto); huboNovedades = true;
      } else if (fechaRemota > fechaLocal) {
        // Aquí sí protegemos: nunca dejamos que un remoto sin nombre/apellidos
        // borre uno local que sí los tiene — evita que un jugador "se quede
        // sin nombre" por una fila incompleta o mal mapeada en el Sheet.
        if (_scoutFusionarSeguro(jDB, idx, remoto, ['nom', 'ape'], ['imgJug', 'imgEsc'])) huboNovedades = true;
      }
    });
  }
  if (respuesta.equipos && respuesta.equipos.length) {
    respuesta.equipos.forEach(r => {
      const remoto = _normalizarRegistro(r);
      if (!remoto.id) return;
      const idx = eDB.findIndex(x => x.id === remoto.id);
      const fechaLocal = idx >= 0 ? new Date(eDB[idx].fecha || 0).getTime() : 0;
      const fechaRemota = new Date(remoto.fechaActualizacion || 0).getTime();
      if (idx < 0) {
        eDB.unshift(remoto); huboNovedades = true;
      } else if (fechaRemota > fechaLocal) {
        if (_scoutFusionarSeguro(eDB, idx, remoto, ['nom'], ['imgEsc'])) huboNovedades = true;
      }
    });
  }
  if (respuesta.partidosVideo && respuesta.partidosVideo.length && typeof pDB !== 'undefined') {
    respuesta.partidosVideo.forEach(r => {
      const remoto = _normalizarRegistro(r);
      if (!remoto.id) return;
      const idx = pDB.findIndex(x => x.id === remoto.id);
      const fechaLocal = idx >= 0 ? new Date(pDB[idx].fechaReg || 0).getTime() : 0;
      const fechaRemota = new Date(remoto.fechaActualizacion || 0).getTime();
      if (idx < 0) {
        if (remoto.local || remoto.visitante) { pDB.unshift(remoto); huboNovedades = true; }
      } else if (fechaRemota > fechaLocal) {
        if (_scoutFusionarSeguro(pDB, idx, remoto, ['local', 'visitante'], ['thumb'])) huboNovedades = true;
      }
    });
  }
  if (respuesta.anuncios && respuesta.anuncios.length && typeof adsDB !== 'undefined') {
    respuesta.anuncios.forEach(r => {
      const remoto = _normalizarRegistro(r);
      if (!remoto.id) return;
      const idx = adsDB.findIndex(x => x.id === remoto.id);
      if (idx < 0) { adsDB.unshift(remoto); huboNovedades = true; }
      else { adsDB[idx] = remoto; huboNovedades = true; }
    });
  }

  localStorage.setItem(SYNC_META_KEY, respuesta.timestamp || new Date().toISOString());

  if (huboNovedades) {
    if (typeof saveJDB === 'function') saveJDB();
    if (typeof saveEDB === 'function') saveEDB();
    if (typeof savePDB === 'function') savePDB();
    if (typeof saveAds === 'function') saveAds();
    if (typeof renderBannerAdsGlobal === 'function') renderBannerAdsGlobal();
    if (typeof currentSection !== 'undefined') {
      if (currentSection === 'jugadores-db' && typeof renderJDB === 'function') renderJDB();
      if (currentSection === 'equipos-db' && typeof renderEDB === 'function') renderEDB();
      if (currentSection === 'partidos' && typeof renderPartidos === 'function') renderPartidos();
      if (currentSection === 'inicio' && typeof renderInicio === 'function') renderInicio();
    }
    _scoutToast('☁️ Datos actualizados desde Google Sheets');
  }
}

/** Sustituye arr[idx] por "remoto", pero:
 *  1) si remoto no trae ninguno de los "camposClave" (p.ej. nom/ape)
 *     mientras el local sí los tenía, conserva esos campos del local
 *     en vez de dejar el registro sin nombre.
 *  2) si remoto no trae imagen en alguno de "camposImagen" (escudo,
 *     foto, miniatura...) pero el local SÍ la tenía, conserva la
 *     imagen local — esto es justo lo que evita que un escudo/foto que
 *     ya estaba bien subido se borre al sincronizar con una fila del
 *     Sheet que se guardó a medias (p.ej. por un fallo anterior). */
function _scoutFusionarSeguro(arr, idx, remoto, camposClave, camposImagen) {
  const local = arr[idx];
  const remotoTieneAlgunCampo = camposClave.some(c => remoto[c]);
  const localTieneAlgunCampo = camposClave.some(c => local[c]);
  const fusionado = { ...remoto };
  if (!remotoTieneAlgunCampo && localTieneAlgunCampo) {
    camposClave.forEach(c => { fusionado[c] = local[c]; });
    console.warn('[Scoutdrive sync] Fila remota sin nombre; se conserva el nombre local para', local.id);
  }
  (camposImagen || []).forEach(c => {
    if (!remoto[c] && local[c]) {
      fusionado[c] = local[c];
      console.warn('[Scoutdrive sync] Fila remota sin imagen (' + c + '); se conserva la local para', local.id);
    }
  });
  arr[idx] = fusionado;
  return true;
}

// ════════════════════════════════════════════════════════════════
//  NORMALIZACIÓN — convierte columnas del Sheet al formato de la app
// ════════════════════════════════════════════════════════════════
function _normalizarRegistro(r) {
  // Si tiene jsonCompleto, esa es la fuente de verdad — contiene el
  // objeto exacto tal como lo generó guardarJ()/guardarE()
  if (r.jsonCompleto) {
    try {
      const obj = JSON.parse(r.jsonCompleto);
      // IMPORTANTE: aunque jsonCompleto traiga imgJug/imgEsc/thumb/img,
      // preferimos siempre la URL de Drive de las columnas planas
      // (fotoURL/escudoURL/thumbURL/imgURL) si existe. Las celdas de
      // Google Sheets tienen un límite de 50.000 caracteres; si la foto
      // era grande en base64, jsonCompleto pudo guardarse truncado, aunque
      // el resto de la ficha esté perfectamente bien. La URL de Drive no
      // tiene ese problema porque es un texto corto.
      if (r.fotoURL)   obj.imgJug = _driveURLViewable(r.fotoURL);
      if (r.escudoURL) obj.imgEsc = _driveURLViewable(r.escudoURL);
      if (r.thumbURL)  obj.thumb  = _driveURLViewable(r.thumbURL);
      if (r.imgURL)    obj.img    = _driveURLViewable(r.imgURL);
      // Por si el jsonCompleto trae directamente una URL de Drive (sin
      // columna plana), la arreglamos también aquí.
      if (obj.imgJug) obj.imgJug = _driveURLViewable(obj.imgJug);
      if (obj.imgEsc) obj.imgEsc = _driveURLViewable(obj.imgEsc);
      if (obj.thumb)  obj.thumb  = _driveURLViewable(obj.thumb);
      if (obj.img)    obj.img    = _driveURLViewable(obj.img);
      // El jsonCompleto ya tiene la estructura correcta (nom, ape, etc.)
      return { ...obj, _sincronizado: true };
    } catch(e) {}
  }

  // Si no hay jsonCompleto (objeto incompleto del Sheet), hacemos el
  // mapeo manual de columnas planas → campos que usa la app
  const normalizado = { ...r, _sincronizado: true };

  // Jugador: columnas del Sheet → campos de la app
  if (r.nombre !== undefined && r.nom === undefined) normalizado.nom = r.nombre;
  if (r.apellidos !== undefined && r.ape === undefined) normalizado.ape = r.apellidos;
  if (r.posicion !== undefined && r.pos === undefined) normalizado.pos = r.posicion;
  if (r.temporada !== undefined && r.temp === undefined) normalizado.temp = r.temporada;
  if (r.nacionalidad !== undefined && r.nac === undefined) normalizado.nac = r.nacionalidad;
  if (r.notaTecnica !== undefined && r.nota === undefined) normalizado.nota = r.notaTecnica;
  if (r.fotoURL !== undefined && !normalizado.imgJug) normalizado.imgJug = _driveURLViewable(r.fotoURL);
  if (r.escudoURL !== undefined && !normalizado.imgEsc) normalizado.imgEsc = _driveURLViewable(r.escudoURL);

  // Equipo: columnas del Sheet → campos de la app
  if (r.nombre !== undefined && r.nom === undefined) normalizado.nom = r.nombre;
  if (r.temporada !== undefined && r.temp === undefined) normalizado.temp = r.temporada;
  if (r.entrenador !== undefined && r.ent === undefined) normalizado.ent = r.entrenador;
  if (r.sistema !== undefined && r.sist === undefined) normalizado.sist = r.sistema;
  if (r.notaTactica !== undefined && r.nota === undefined) normalizado.nota = r.notaTactica;
  if (r.escudoURL !== undefined && !normalizado.imgEsc) normalizado.imgEsc = _driveURLViewable(r.escudoURL);

  // PartidoVideo / Anuncio: columnas planas → campos de la app
  if (r.thumbURL !== undefined && !normalizado.thumb) normalizado.thumb = _driveURLViewable(r.thumbURL);
  if (r.imgURL !== undefined && !normalizado.img) normalizado.img = _driveURLViewable(r.imgURL);

  // Stats del equipo
  if (!normalizado.stats && (r.pj !== undefined)) {
    normalizado.stats = {
      pj: +r.pj||0, v: +r.victorias||0, e: +r.empates||0,
      d: +r.derrotas||0, gf: +r.golesFavor||0, gc: +r.golesContra||0
    };
  }

  return normalizado;
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
    const reconstruidos = respuesta.jugadores.map(_normalizarRegistro);
    // Reemplazar o añadir — el Sheet es la fuente de verdad en sync completo
    reconstruidos.forEach(remoto => {
      if (!remoto.id) return;
      const idx = (typeof jDB !== 'undefined') ? jDB.findIndex(x => x.id === remoto.id) : -1;
      if (idx >= 0) { _scoutFusionarSeguro(jDB, idx, remoto, ['nom', 'ape'], ['imgJug', 'imgEsc']); cambios++; }
      else if (typeof jDB !== 'undefined') { jDB.unshift(remoto); cambios++; }
    });
  }

  if (respuesta.equipos && respuesta.equipos.length) {
    const reconstruidos = respuesta.equipos.map(_normalizarRegistro);
    reconstruidos.forEach(remoto => {
      if (!remoto.id) return;
      const idx = (typeof eDB !== 'undefined') ? eDB.findIndex(x => x.id === remoto.id) : -1;
      if (idx >= 0) { _scoutFusionarSeguro(eDB, idx, remoto, ['nom'], ['imgEsc']); cambios++; }
      else if (typeof eDB !== 'undefined') { eDB.unshift(remoto); cambios++; }
    });
  }

  if (respuesta.partidosVideo && respuesta.partidosVideo.length && typeof pDB !== 'undefined') {
    const reconstruidos = respuesta.partidosVideo.map(_normalizarRegistro);
    reconstruidos.forEach(remoto => {
      if (!remoto.id) return;
      const idx = pDB.findIndex(x => x.id === remoto.id);
      if (idx >= 0) { _scoutFusionarSeguro(pDB, idx, remoto, ['local', 'visitante'], ['thumb']); cambios++; }
      else { pDB.unshift(remoto); cambios++; }
    });
  }

  if (respuesta.anuncios && respuesta.anuncios.length && typeof adsDB !== 'undefined') {
    const reconstruidos = respuesta.anuncios.map(_normalizarRegistro);
    reconstruidos.forEach(remoto => {
      if (!remoto.id) return;
      const idx = adsDB.findIndex(x => x.id === remoto.id);
      if (idx >= 0) { adsDB[idx] = remoto; cambios++; }
      else { adsDB.unshift(remoto); cambios++; }
    });
  }

  localStorage.setItem(SYNC_META_KEY, respuesta.timestamp || new Date().toISOString());

  if (cambios > 0) {
    if (typeof saveJDB === 'function') saveJDB();
    if (typeof saveEDB === 'function') saveEDB();
    if (typeof savePDB === 'function') savePDB();
    if (typeof saveAds === 'function') saveAds();
    if (typeof renderJDB === 'function') renderJDB();
    if (typeof renderEDB === 'function') renderEDB();
    if (typeof renderBannerAdsGlobal === 'function') renderBannerAdsGlobal();
    if (typeof currentSection !== 'undefined' && currentSection === 'partidos' && typeof renderPartidos === 'function') renderPartidos();
    if (typeof currentSection !== 'undefined' && currentSection === 'inicio' && typeof renderInicio === 'function') renderInicio();
    _scoutToast(`☁️ ${cambios} elemento${cambios !== 1 ? 's' : ''} sincronizado${cambios !== 1 ? 's' : ''}`);
  } else {
    if (!silencioso) _scoutToast('✅ Todo actualizado');
  }

  if (btn) { btn.textContent = '🔄'; btn.disabled = false; }
}



// Antes esto se disparaba solo a los 1.2s de cargar la página — es decir,
// justo mientras el usuario está escribiendo el usuario/contraseña. En
// móviles con conexión lenta, esa sincronización de fondo competía por
// la red con el propio envío del login, y todo se sentía lento.
// Ahora esperamos a que el login haya terminado (ver window.scoutSyncInicial,
// llamado desde el bloque de login en index.html) para no interferir.
window.scoutSyncInicial = async function scoutSyncInicial() {
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
};
