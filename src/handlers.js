import { redis, rateLimit, cooldown } from './redis.js';
import { logger } from './logger.js';

const COOLDOWN_MS = 5000;
const RATE_MAX = 10;
const RATE_WINDOW_SEC = 60;
const BIENVENIDA_TTL_SEC = 7 * 24 * 60 * 60;

const FIRMA = '────────────────────────\nAsistente de Activación';
const SOPORTE = '🕐 Soporte: L-V de 9:00 a 18:00';
const PRECIO = '25€';

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
    `▸ /codigo — comprar o ver tu código\n` +
    `▸ /miscompras — historial de compras\n` +
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

// ─── COMANDOS ───

export async function procesarComando(bot, chatId, userId, username, comando, param) {
  if (comando === 'start') {
    if (param === 'pago_ok') {
      // El código real llegará por el webhook del servidor
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
          inline_keyboard: [[{ text: `💳 Comprar código - ${PRECIO}`, callback_data: 'comprar' }]],
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
          reply_markup: { inline_keyboard: [[{ text: '💳 Comprar código', callback_data: 'comprar' }]] },
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

  if (comando === 'comprar') {
    await iniciarCompra(bot, chatId, userId, username);
    return;
  }
}

export async function procesarMensaje(bot, chatId, userId, username, texto) {
  const textoNorm = texto.trim().toLowerCase();

  if (['ayuda', 'help'].some((p) => textoNorm.includes(p))) {
    await enviar(bot, chatId, msgAyuda());
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

  const primeraVez = await esPrimeraVez(userId);
  if (primeraVez) {
    await enviar(bot, chatId, msgBienvenida(), {
      reply_markup: { inline_keyboard: [[{ text: `💳 Comprar código - ${PRECIO}`, callback_data: 'comprar' }]] },
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