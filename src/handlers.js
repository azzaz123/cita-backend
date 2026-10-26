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

// ─── DESCARGA ───
const DOWNLOAD_SECRET = process.env.DOWNLOAD_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'https://automate-9ij2.onrender.com';
const DOWNLOAD_TOKEN_TTL = parseInt(process.env.DOWNLOAD_TOKEN_TTL || '900000'); // 15 min
const DOWNLOAD_ONLY_BUYERS = process.env.DOWNLOAD_ONLY_BUYERS === 'true';

// ─── INSTALL VIDEO ───
const INSTALL_VIDEO_PATH = process.env.INSTALL_VIDEO_PATH || 'videos/install.mp4';

// ─── STARS ───
const STARS_PRECIO = parseInt(process.env.STARS_PRECIO || '2500'); // 2500 Stars por defecto
const STARS_PRODUCTO = 'Código Premium - 3 meses';

// ─── PLANTILLAS ───

function msgBienvenida() {
  return (
    `👋 BIENVENIDO\n\n` +
    `Soy tu Asistente de Activación.\n\n` +
    `Para activar la app necesitas un código.\n\n` +
    `💎 CÓDIGO PREMIUM\n` +
    `▸ Duración: 3 meses\n` +
    `▸ Válido para 2 NIEs\n` +
    `▸ Precio: ${PRECIO} (pago seguro con tarjeta)\n\n` +
    `▸ Usa /codigo para comprar tu código.\n\n` +
    `${SOPORTE}\n\n` +
    `${FIRMA}`
  );
}

function msgComprar() {
  return (
    `💎 CÓDIGO PREMIUM\n\n` +
    `Características:\n` +
    `▸ Duración: 3 meses (90 días)\n` +
    `▸ Válido para 2 NIEs\n` +
    `▸ Activación inmediata\n\n` +
    `Precio: ${PRECIO}\n\n` +
    `Pulsa el botón para pagar de forma segura.`
  );
}

function msgCodigoComprado(codigo) {
  return (
    `✅ PAGO CONFIRMADO\n\n` +
    `¡Gracias por tu compra!\n\n` +
    `Tu código PREMIUM es:\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `    ${codigo}\n` +
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
    `    ${codigo}\n` +
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
    `▸ /stars — pagar con Telegram Stars\n` +
    `▸ /codigo — comprar o ver tu código\n` +
    `▸ /miscompras — historial de compras\n` +
    `▸ /descargar — descargar la app\n` +
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

  const lista = compras.map((c, i) => {
    const fecha = c.creado_en ? new Date(c.creado_en).toLocaleDateString('es-ES') : '—';
    return `${i + 1}. ${c.codigo}\n   ${fecha} · ${c.entregado ? '✅ activo' : '⏳ pendiente'}`;
  }).join('\n\n');

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

async function obtenerMisCompras(userId) {
  try {
    const res = await fetch(`${process.env.API_URL}/api/bot/mis-compras/${userId}`, {
      headers: { 'x-api-key': process.env.API_KEY },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.compras || [];
  } catch (err) {
    return [];
  }
}

async function marcarEntregado(userId, codigo) {
  try {
    await fetch(`${process.env.API_URL}/api/bot/entregar/${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY },
      body: JSON.stringify({ codigo }),
    });
  } catch (err) {}
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

    if (DOWNLOAD_ONLY_BUYERS) {
      const compras = await obtenerMisCompras(userId);
      if (!compras || compras.length === 0) {
        await enviar(bot, chatId,
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

// ─── COMANDO /install (vídeo de instalación) ───

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
      await enviar(bot, chatId,
        `⚠️ El vídeo pesa ${sizeMB} MB y supera el límite de Telegram (50 MB).\n\n` +
        `Contacta con soporte para recibirlo por otro medio.\n\n${SOPORTE}`
      );
      return;
    }

    try {
      const sent = await bot.sendMessage(chatId,
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
      contentType: 'video/mp4',
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
          {
            chat_id: chatId,
            message_id: loadingMsg,
            parse_mode: 'Markdown',
          }
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
        await bot.editMessageText(
          `❌ *ERROR AL ENVIAR EL VÍDEO*\n\nInténtalo de nuevo en unos minutos.\n\n${SOPORTE}`,
          { chat_id: chatId, message_id: loadingMsg, parse_mode: 'Markdown' }
        );
      } catch (e) {}
    } else {
      await enviar(bot, chatId, msgError());
    }
  }
}

// ─── COMANDO /stars (factura Telegram Stars) ───

export async function enviarFacturaStars(bot, chatId, userId, username) {
  try {
    const rl = await rateLimit(`tg:rl:stars:${userId}`, 3, 60);
    if (!rl.allowed) {
      await enviar(bot, chatId, '⏳ Demasiadas peticiones. Espera un momento.');
      return;
    }

    const payload = `stars_${userId}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

    const insertRes = await fetch(`${process.env.API_URL}/api/bot/stars/pending`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.API_KEY,
      },
      body: JSON.stringify({
        payload,
        user_id: String(userId),
        username: username || '',
        amount_stars: STARS_PRECIO,
      }),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      logger.error({ errText, payload }, 'Error guardando compra Stars pending');
      await enviar(bot, chatId, msgError());
      return;
    }

    await bot.sendInvoice(
      chatId,
      STARS_PRODUCTO,
      `Código de activación válido por 90 días para 2 NIEs.\n\nRecibirás el código automáticamente tras el pago.`,
      payload,
      '',
      'XTR',
      [{ label: STARS_PRODUCTO, amount: STARS_PRECIO }],
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `⭐ Pagar ${STARS_PRECIO} Stars`, pay: true }],
          ],
        },
      }
    );

    logger.info({ userId, username, payload, stars: STARS_PRECIO }, '⭐ Factura Stars enviada');
  } catch (err) {
    logger.error({ err, userId }, 'Error enviando factura Stars');
    await enviar(bot, chatId, msgError());
  }
}

// ─── COMANDOS ───

export async function procesarComando(bot, chatId, userId, username, comando, param) {
  if (comando === 'start') {
    if (param === 'pago_ok') {
      return;
    }
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
            [{ text: `💳 Comprar código - ${PRECIO}`, callback_data: 'comprar' }],
            [{ text: '📥 Descargar app', callback_data: 'descargar' }],
          ],
        },
      });
    } else {
      const compras = await obtenerMisCompras(userId);
      const pendientes = compras.filter(c => !c.entregado);
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
              [{ text: '💳 Comprar código', callback_data: 'comprar' }],
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
    await enviar(bot, chatId, msgMisCompras(compras));
    return;
  }

  if (comando === 'stars') {
    await enviarFacturaStars(bot, chatId, userId, username);
    return;
  }

  if (comando === 'comprar') {
    await iniciarCompra(bot, chatId, userId, username);
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
  if (['stars', 'estrella', 'estrellas'].some((p) => textoNorm.includes(p))) {
    await enviarFacturaStars(bot, chatId, userId, username);
    return;
  }
  if (['codigo', 'código', 'code', 'comprar', 'quiero'].some((p) => textoNorm.includes(p))) {
    await pedirCodigo(bot, chatId, userId, username);
    return;
  }
  if (['compras', 'historial'].some((p) => textoNorm.includes(p))) {
    const compras = await obtenerMisCompras(userId);
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
          [{ text: `💳 Comprar código - ${PRECIO}`, callback_data: 'comprar' }],
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
  const pendientes = compras.filter(c => !c.entregado);

  if (pendientes.length > 0) {
    for (const compra of pendientes) {
      await enviar(bot, chatId, msgCodigoComprado(compra.codigo));
      await marcarEntregado(userId, compra.codigo);
    }
    return;
  }

  const activos = compras.filter(c => c.entregado);
  if (activos.length > 0) {
    await enviar(bot, chatId, msgCodigoExistente(activos[0].codigo), {
      reply_markup: { inline_keyboard: [[{ text: '💳 Comprar otro código', callback_data: 'comprar' }]] },
    });
    return;
  }

  await enviar(bot, chatId, msgComprar(), {
    reply_markup: { inline_keyboard: [[{ text: `💳 Comprar ahora - ${PRECIO}`, callback_data: 'comprar' }]] },
  });
}

async function iniciarCompra(bot, chatId, userId, username) {
  try {
    const res = await fetch(`${process.env.API_URL}/api/bot/comprar-codigo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY },
      body: JSON.stringify({ user_id: String(userId), username: username || '' }),
    });

    if (!res.ok) {
      logger.error({ status: res.status }, 'Error creando compra');
      await enviar(bot, chatId, msgError());
      return;
    }

    const data = await res.json();
    if (!data.success || !data.checkout_url) {
      await enviar(bot, chatId, msgError());
      return;
    }

    await enviar(bot, chatId,
      `💳 PAGO SEGURO\n\nPulsa el botón para pagar ${PRECIO} de forma segura con Stripe.\n\nUna vez completado el pago, recibirás tu código automáticamente aquí.\n\n⚠️ No cierres Telegram hasta terminar el pago.`,
      {
        reply_markup: { inline_keyboard: [[{ text: `💳 Pagar ${PRECIO}`, url: data.checkout_url }]] },
      });
  } catch (err) {
    logger.error({ err, userId }, 'Error iniciando compra');
    await enviar(bot, chatId, msgError());
  }
}