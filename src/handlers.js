import crypto from 'crypto';
import { redis, rateLimit, cooldown } from './redis.js';
import { logger } from './logger.js';
import fs from 'fs';
import path from 'path';

const COOLDOWN_MS = 5000;
const RATE_MAX = 10;
const RATE_WINDOW_SEC = 60;
const BIENVENIDA_TTL_SEC = 7 * 24 * 60 * 60;

const FIRMA = '────────────────────────\nAsistente de Activación';
const SOPORTE = '🕐 Soporte: L-V de 9:00 a 18:00';
const PRECIO = '25€';

// ─── STARS ───
const PRECIO_STARS = parseInt(process.env.PRECIO_STARS || '150', 10); // nº de Telegram Stars
const STARS_CURRENCY = 'XTR';

// ─── DESCARGA ───
const DOWNLOAD_SECRET = process.env.DOWNLOAD_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'https://automate-9ij2.onrender.com';
const DOWNLOAD_TOKEN_TTL = parseInt(process.env.DOWNLOAD_TOKEN_TTL || '900000');

// ─── INSTALL VIDEO ───
const INSTALL_VIDEO_PATH = process.env.INSTALL_VIDEO_PATH || 'videos/install.mp4';

// ─── HELPERS DE ESCAPE (defensa en profundidad) ───
function escMarkdown(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ─── PLANTILLAS ───

function msgBienvenida() {
  return (
    `👋 BIENVENIDO\n\n` +
    `Soy tu Asistente de Activación.\n\n` +
    `Para activar la app necesitas un código.\n\n` +
    `💎 CÓDIGO PREMIUM\n` +
    `▸ Duración: 3 meses\n` +
    `▸ Válido para 2 NIEs\n` +
    `▸ Precio: ${PRECIO} (pago seguro con Telegram Stars ⭐)\n\n` +
    `▸ Usa /codigo para comprar tu código.\n\n` +
    `${SOPORTE}\n\n` +
    `${FIRMA}`
  );
}

function msgComprarStars() {
  return (
    `💎 CÓDIGO PREMIUM\n\n` +
    `Características:\n` +
    `▸ Duración: 3 meses (90 días)\n` +
    `▸ Válido para 2 NIEs\n` +
    `▸ Activación inmediata\n\n` +
    `Precio: ${PRECIO}\n\n` +
    `Pulsa el botón para pagar con Telegram Stars ⭐.`
  );
}

export function msgCodigoComprado(codigo) {
  return (
    `✅ PAGO CONFIRMADO\n\n` +
    `¡Gracias por tu compra!\n\n` +
    `Tu código PREMIUM es:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `    ${escMarkdown(codigo)}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `▸ Válido por 3 meses desde su activación\n` +
    `▸ Válido para este dispositivo\n` +
    `▸ Úsalo en la app para activar\n\n` +
    `${SOPORTE}\n\n` +
    `${FIRMA}`
  );
}

function msgCodigoExistente(codigo) {
  return (
    `📋 YA TIENES UN CÓDIGO\n\n` +
    `Tu código premium es:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `    ${escMarkdown(codigo)}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `▸ Aún no lo has activado en la app.\n` +
    `▸ Ábrelo en la app para activar.\n\n` +
    `Si quieres otro código (para otra\n` +
    `persona u otro dispositivo), pulsa\n` +
    `el botón de abajo.\n\n` +
    `${SOPORTE}\n\n` +
    `${FIRMA}`
  );
}

function msgAyuda() {
  return (
    `ℹ️ AYUDA\n\n` +
    `Comandos:\n\n` +
    `▸ /install — ver tutorial de instalación\n` +
    `▸ /codigo — comprar o ver tu código\n` +
    `▸ /miscompras — historial de compras\n` +
    `▸ /descargar — descargar la app\n` +
    `▸ /stars — pagar con Telegram Stars ⭐\n` +
    `▸ /ayuda — este mensaje\n\n` +
    `${SOPORTE}\n\n` +
    `${FIRMA}`
  );
}

function msgError() {
  return (
    `⚠️ ERROR DE SERVICIO\n\n` +
    `No hemos podido procesar tu solicitud.\n` +
    `Inténtalo de nuevo en unos minutos.\n\n` +
    `${SOPORTE}\n\n` +
    `${FIRMA}`
  );
}

function msgMisCompras(compras) {
  if (!compras || compras.length === 0) {
    return `📭 SIN COMPRAS\n\nAún no has comprado ningún código.\n\nUsa /codigo para comprar tu primero.\n\n${SOPORTE}\n\n${FIRMA}`;
  }

  const lista = compras
    .map((c, i) => {
      const fecha = c.creado_en ? new Date(c.creado_en).toLocaleDateString('es-ES') : '—';
      const estado = c.entregado ? '✅ activo' : '⏳ pendiente';
      return `${i + 1}. ${escMarkdown(c.codigo)}\n   ${fecha} · ${estado}`;
    })
    .join('\n\n');

  return `📋 MIS COMPRAS\n\n${lista}\n\nTotal: ${compras.length} código(s)\n\n${SOPORTE}\n\n${FIRMA}`;
}

// ─── HELPERS ───

export async function enviar(bot, chatId, texto, opciones = {}) {
  try {
    await bot.sendMessage(chatId, texto, { parse_mode: 'Markdown', ...opciones });
  } catch (err) {
    logger.error({ err, chatId }, 'Error enviando mensaje');
  }
}

async function esPrimeraVez(userId) {
  const key = `tg:bienvenida:${userId}`;
  const res = await redis.set(key, '1', 'EX', BIENVENIDA_TTL_SEC, 'NX');
  return res === 'OK';
}

/**
 * Devuelve:
 *  - Array de compras (puede ser []) si OK
 *  - null si hubo error de red/servidor (distinguible de "sin compras")
 */
async function obtenerMisCompras(userId) {
  try {
    const res = await fetch(`${process.env.API_URL}/api/bot/mis-compras/${encodeURIComponent(userId)}`, {
      headers: { 'x-api-key': process.env.API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, userId }, 'mis-compras: respuesta no OK');
      return null;
    }
    const data = await res.json();
    return Array.isArray(data.compras) ? data.compras : [];
  } catch (err) {
    logger.error({ err, userId }, 'mis-compras: error de red');
    return null;
  }
}

async function marcarEntregado(userId, codigo) {
  try {
    const res = await fetch(`${process.env.API_URL}/api/bot/entregar/${encodeURIComponent(userId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY },
      body: JSON.stringify({ codigo }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, userId }, 'marcarEntregado: respuesta no OK');
    }
  } catch (err) {
    logger.error({ err, userId }, 'marcarEntregado: error de red');
  }
}

// ─── GENERACIÓN DE TOKEN DE DESCARGA ───

function generarTokenDescarga(userId) {
  if (!DOWNLOAD_SECRET) {
    throw new Error('DOWNLOAD_SECRET no configurado');
  }
  const payload = {
    uid: String(userId),
    exp: Date.now() + DOWNLOAD_TOKEN_TTL,
    iat: Date.now(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const firma = crypto
    .createHmac('sha256', DOWNLOAD_SECRET)
    .update(payloadB64)
    .digest('base64url');
  return { token: `${payloadB64}.${firma}`, exp: payload.exp };
}

// ─── COMANDO /descargar ───

export async function procesarDescarga(bot, chatId, userId, username) {
  try {
    const rl = await rateLimit(`tg:rl:descargar:${userId}`, 3, 60);
    if (!rl.allowed) {
      await enviar(bot, chatId, '⏳ Demasiadas peticiones. Espera un momento.');
      return;
    }

    if (process.env.DOWNLOAD_ONLY_BUYERS === 'true') {
      const compras = await obtenerMisCompras(userId);
      if (compras === null) {
        await enviar(bot, chatId, msgError());
        return;
      }
      if (compras.length === 0) {
        await enviar(
          bot,
          chatId,
          '⚠️ *ACCESO RESTRINGIDO*\n\n' +
            'Necesitas comprar un código primero para descargar la app.\n\n' +
            'Usa /codigo para comprar tu código.\n\n' +
            `${SOPORTE}\n\n${FIRMA}`
        );
        return;
      }
    }

    if (!DOWNLOAD_SECRET) {
      await enviar(bot, chatId, '⚠️ La descarga no está configurada. Contacta con soporte.');
      return;
    }

    const { token, exp } = generarTokenDescarga(userId);

    try {
      await fetch(`${BACKEND_URL}/api/download/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.API_KEY,
        },
        body: JSON.stringify({ token, exp, uid: String(userId) }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      logger.error({ err }, 'Error registrando token de descarga');
    }

    const url = `${BACKEND_URL}/api/download/${encodeURIComponent(token)}`;
    const minutos = Math.round(DOWNLOAD_TOKEN_TTL / 60000);

    const msg =
      `📥 *DESCARGA DE LA APP*\n\n` +
      `Pulsa el botón para descargar la app.\n\n` +
      `▸ Enlace válido durante *${minutos} minutos*\n` +
      `▸ Solo se puede usar *una vez*\n` +
      `▸ Si caduca, usa /descargar de nuevo\n\n` +
      `⚠️ *Importante*: después de descargar, abre el archivo .apk en tu Android para instalarla. Tendrás que permitir "instalar apps de origen desconocido".\n\n` +
      `${SOPORTE}\n\n${FIRMA}`;

    await enviar(bot, chatId, msg, {
      reply_markup: {
        inline_keyboard: [[{ text: '📥 Descargar APK', url }]],
      },
    });

    logger.info({ userId, username }, '📥 Enlace de descarga generado');
  } catch (err) {
    logger.error({ err, userId }, 'Error generando descarga');
    await enviar(bot, chatId, msgError());
  }
}

// ─── COMANDO /install ───

export async function procesarInstall(bot, chatId, userId, username) {
  let loadingMsg = null;
  try {
    const rl = await rateLimit(`tg:rl:install:${userId}`, 3, 60);
    if (!rl.allowed) {
      await enviar(bot, chatId, '⏳ Demasiadas peticiones. Espera un momento.');
      return;
    }

    const videoPath = path.isAbsolute(INSTALL_VIDEO_PATH)
      ? INSTALL_VIDEO_PATH
      : path.join(process.cwd(), INSTALL_VIDEO_PATH);

    if (!fs.existsSync(videoPath)) {
      logger.error({ videoPath }, 'Vídeo de instalación no encontrado');
      await enviar(bot, chatId, '⚠️ El vídeo de instalación no está disponible ahora mismo. Inténtalo más tarde.');
      return;
    }

    const stats = fs.statSync(videoPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);

    if (stats.size > 50 * 1024 * 1024) {
      logger.error({ sizeMB }, 'Vídeo supera el límite de Telegram');
      await enviar(
        bot,
        chatId,
        `⚠️ El vídeo pesa ${sizeMB} MB y supera el límite de Telegram (50 MB).\n\n` +
          `Contacta con soporte para recibirlo por otro medio.\n\n${SOPORTE}`
      );
      return;
    }

    try {
      const sent = await bot.sendMessage(
        chatId,
        `⏳ *PREPARANDO EL VÍDEO...*\n\n` +
          `▸ Peso: ${sizeMB} MB\n` +
          `▸ Duración estimada de envío: ${Math.max(5, Math.ceil(sizeMB / 3))} segundos\n\n` +
          `_No cierres el chat, el vídeo se enviará automáticamente._`,
        { parse_mode: 'Markdown' }
      );
      loadingMsg = sent.message_id;
    } catch (err) {
      logger.error({ err }, 'Error enviando mensaje de loading');
    }

    try {
      await bot.sendChatAction(chatId, 'upload_video');
    } catch (err) {
      logger.error({ err }, 'Error enviando chat action');
    }

    await bot.sendVideo(chatId, videoPath, {
      caption: `📱 *Instalación de Cita Previa* (${sizeMB} MB)\n\nSigue los pasos del vídeo.`,
      parse_mode: 'Markdown',
      supports_streaming: true,
    });

    if (loadingMsg) {
      try {
        await bot.editMessageText(
          `✅ *VÍDEO ENVIADO*\n\n` +
            `Si no lo ves arriba, baja en el chat.\n\n` +
            `▸ Descarga el archivo .apk desde /descargar\n` +
            `▸ Ábrelo en tu Android\n` +
            `▸ Permite "instalar apps de origen desconocido"\n` +
            `▸ Sigue los pasos del vídeo\n\n` +
            `${SOPORTE}\n\n${FIRMA}`,
          { chat_id: chatId, message_id: loadingMsg, parse_mode: 'Markdown' }
        );
      } catch (err) {
        logger.error({ err }, 'Error editando mensaje de loading');
      }
    }

    logger.info({ userId, username, sizeMB }, '🎬 Vídeo de instalación enviado');
  } catch (err) {
    logger.error({ err, userId }, 'Error enviando vídeo de instalación');
    if (loadingMsg) {
      try {
        await bot.editMessageText(`❌ *ERROR AL ENVIAR EL VÍDEO*\n\nInténtalo de nuevo en unos minutos.\n\n${SOPORTE}`, {
          chat_id: chatId,
          message_id: loadingMsg,
          parse_mode: 'Markdown',
        });
      } catch (e) {}
    } else {
      await enviar(bot, chatId, msgError());
    }
  }
}

// ─── COMANDOS ───

export async function procesarComando(bot, chatId, userId, username, comando, param) {
  if (comando === 'start') {
    if (param === 'pago_ok') return;
    if (param === 'pago_cancel') {
      await enviar(bot, chatId, '❌ Pago cancelado.\n\nUsa /codigo si quieres intentarlo de nuevo.');
      return;
    }

    const primeraVez = await esPrimeraVez(userId);
    if (primeraVez) {
      await enviar(bot, chatId, msgBienvenida(), {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎬 Ver tutorial de instalación', callback_data: 'install' }],
            [{ text: `⭐ Comprar código - ${PRECIO}`, callback_data: 'stars' }],
            [{ text: '📥 Descargar app', callback_data: 'descargar' }],
          ],
        },
      });
    } else {
      const compras = await obtenerMisCompras(userId);
      if (compras === null) {
        await enviar(bot, chatId, msgError());
        return;
      }
      const pendientes = compras.filter((c) => !c.entregado);
      if (pendientes.length > 0) {
        for (const compra of pendientes) {
          await enviar(bot, chatId, msgCodigoComprado(compra.codigo));
          await marcarEntregado(userId, compra.codigo);
        }
      } else {
        await enviar(bot, chatId, '👋 Bienvenido de vuelta.\n\nUsa /codigo para comprar tu código.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎬 Ver tutorial de instalación', callback_data: 'install' }],
              [{ text: '⭐ Comprar código', callback_data: 'stars' }],
              [{ text: '📥 Descargar app', callback_data: 'descargar' }],
            ],
          },
        });
      }
    }
    return;
  }

  if (comando === 'codigo') {
    await pedirCodigo(bot, chatId, userId, username);
    return;
  }

  if (comando === 'ayuda') {
    await enviar(bot, chatId, msgAyuda());
    return;
  }

  if (comando === 'miscompras') {
    const compras = await obtenerMisCompras(userId);
    if (compras === null) {
      await enviar(bot, chatId, msgError());
      return;
    }
    await enviar(bot, chatId, msgMisCompras(compras));
    return;
  }

  if (comando === 'descargar') {
    await procesarDescarga(bot, chatId, userId, username);
    return;
  }

  if (comando === 'install') {
    await procesarInstall(bot, chatId, userId, username);
    return;
  }

  if (comando === 'stars') {
    await enviarFacturaStars(bot, chatId, userId, username);
    return;
  }
}

export async function procesarMensaje(bot, chatId, userId, username, texto) {
  const textoNorm = texto.trim().toLowerCase();

  if (['ayuda', 'help'].some((p) => textoNorm.includes(p))) {
    await enviar(bot, chatId, msgAyuda());
    return;
  }
  if (['install', 'instalar', 'instalación', 'instalacion'].some((p) => textoNorm.includes(p))) {
    await procesarInstall(bot, chatId, userId, username);
    return;
  }
  if (['codigo', 'código', 'code', 'comprar', 'quiero', 'stars'].some((p) => textoNorm.includes(p))) {
    await pedirCodigo(bot, chatId, userId, username);
    return;
  }
  if (['compras', 'historial'].some((p) => textoNorm.includes(p))) {
    const compras = await obtenerMisCompras(userId);
    if (compras === null) {
      await enviar(bot, chatId, msgError());
      return;
    }
    await enviar(bot, chatId, msgMisCompras(compras));
    return;
  }
  if (['descargar', 'descarga', 'apk'].some((p) => textoNorm.includes(p))) {
    await procesarDescarga(bot, chatId, userId, username);
    return;
  }

  const primeraVez = await esPrimeraVez(userId);
  if (primeraVez) {
    await enviar(bot, chatId, msgBienvenida(), {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎬 Ver tutorial de instalación', callback_data: 'install' }],
          [{ text: `⭐ Comprar código - ${PRECIO}`, callback_data: 'stars' }],
          [{ text: '📥 Descargar app', callback_data: 'descargar' }],
        ],
      },
    });
  }
}

async function pedirCodigo(bot, chatId, userId, username) {
  const rl = await rateLimit(`tg:rl:${userId}`, RATE_MAX, RATE_WINDOW_SEC);
  if (!rl.allowed) {
    await enviar(bot, chatId, '⏳ Demasiadas peticiones. Espera un momento.');
    return;
  }
  const puede = await cooldown(`tg:cd:${userId}`, COOLDOWN_MS);
  if (!puede) {
    await enviar(bot, chatId, '⏳ Espera unos segundos.');
    return;
  }

  const compras = await obtenerMisCompras(userId);
  if (compras === null) {
    await enviar(bot, chatId, msgError());
    return;
  }

  const pendientes = compras.filter((c) => !c.entregado);
  if (pendientes.length > 0) {
    for (const compra of pendientes) {
      await enviar(bot, chatId, msgCodigoComprado(compra.codigo));
      await marcarEntregado(userId, compra.codigo);
    }
    return;
  }

  const activos = compras.filter((c) => c.entregado);
  if (activos.length > 0) {
    await enviar(bot, chatId, msgCodigoExistente(activos[0].codigo), {
      reply_markup: { inline_keyboard: [[{ text: '⭐ Comprar otro código', callback_data: 'stars' }]] },
    });
    return;
  }

  await enviar(bot, chatId, msgComprarStars(), {
    reply_markup: {
      inline_keyboard: [[{ text: `⭐ Pagar ${PRECIO} con Telegram Stars`, callback_data: 'stars' }]],
    },
  });
}

// ─── STARS: enviar factura ───
// REGLA: registrar el pending en backend ANTES de sendInvoice.
// Si falla el registro, NO se envía la factura (evita usuarios pagando sin código).

export async function enviarFacturaStars(bot, chatId, userId, username) {
  try {
    const rl = await rateLimit(`tg:rl:stars:${userId}`, 5, 60);
    if (!rl.allowed) {
      await enviar(bot, chatId, '⏳ Demasiadas peticiones. Espera un momento.');
      return;
    }
    const puede = await cooldown(`tg:cd:stars:${userId}`, COOLDOWN_MS);
    if (!puede) {
      await enviar(bot, chatId, '⏳ Espera unos segundos.');
      return;
    }

    // 1) Payload impredecible (UUID v4)
    const payload = crypto.randomUUID();

    // 2) Registrar pending en backend
    let ok = false;
    try {
      const res = await fetch(`${process.env.API_URL}/api/bot/stars/pending`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.API_KEY,
        },
        body: JSON.stringify({
          payload,
          user_id: String(userId),
          username: username || '',
          amount_stars: PRECIO_STARS,
        }),
        signal: AbortSignal.timeout(8000),
      });
      ok = res.ok;
      if (!ok) {
        const text = await res.text().catch(() => '');
        logger.error({ status: res.status, text }, 'stars/pending: respuesta no OK');
      }
    } catch (err) {
      logger.error({ err }, 'stars/pending: error de red');
    }

    if (!ok) {
      // No enviamos factura: el usuario no debe pagar sin pending
      await enviar(bot, chatId, msgError());
      return;
    }

    // 3) Enviar factura Stars
    await bot.sendInvoice(
      chatId,
      'Código Premium - 3 meses',
      'Código de activación válido por 90 días para 2 NIEs. Pago único con Telegram Stars.',
      payload,
      STARS_CURRENCY,
      [{ label: 'Código Premium', amount: PRECIO_STARS }],
      { provider_token: '' } // obligatorio vacío para Stars
    );

    logger.info({ userId, payload }, '⭐ Factura Stars enviada');
  } catch (err) {
    logger.error({ err, userId }, 'Error enviando factura Stars');
    await enviar(bot, chatId, msgError());
  }
}