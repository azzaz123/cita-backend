import TelegramBot from 'node-telegram-bot-api';
import { logger } from './logger.js';
import {
  procesarComando,
  procesarMensaje,
  procesarDescarga,
  procesarInstall,
  enviarFacturaStars,
  enviar,
  msgCodigoComprado,
} from './handlers.js';

// Texto de soporte local (por si no quieres exportarlo desde handlers.js)
const SOPORTE = '🕐 Soporte: L-V de 9:00 a 18:00';

let bot;

export function iniciarTelegram() {
  bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

  logger.info('✅ Bot de Telegram conectado');

  // /start (con o sin parámetros)
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || 'Usuario';
    const param = match[1] || null;

    logger.info({ userId, username, param }, '📨 Comando /start');
    await procesarComando(bot, chatId, userId, username, 'start', param);
  });

  // /codigo
  bot.onText(/\/(codigo|code)/, async (msg) => {
    await procesarComando(
      bot, msg.chat.id, msg.from.id,
      msg.from.username || msg.from.first_name || 'Usuario',
      'codigo', null
    );
  });

  // /ayuda
  bot.onText(/\/(ayuda|help)/, async (msg) => {
    await procesarComando(bot, msg.chat.id, msg.from.id, msg.from.username, 'ayuda', null);
  });

  // /install
  bot.onText(/\/(install|instalar)/, async (msg) => {
    await procesarInstall(
      bot,
      msg.chat.id,
      msg.from.id,
      msg.from.username || msg.from.first_name || 'Usuario'
    );
  });

  // /miscompras
  bot.onText(/\/miscompras/, async (msg) => {
    await procesarComando(bot, msg.chat.id, msg.from.id, msg.from.username, 'miscompras', null);
  });

  // /descargar
  bot.onText(/\/descargar/, async (msg) => {
    await procesarDescarga(
      bot,
      msg.chat.id,
      msg.from.id,
      msg.from.username || msg.from.first_name || 'Usuario'
    );
  });

  // ⭐ COMANDO /stars
  bot.onText(/\/stars/, async (msg) => {
    await enviarFacturaStars(
      bot,
      msg.chat.id,
      msg.from.id,
      msg.from.username || msg.from.first_name || 'Usuario'
    );
  });

  // Mensajes de texto libre
  bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return;
    if (!msg.text) return;

    await procesarMensaje(
      bot, msg.chat.id, msg.from.id,
      msg.from.username || msg.from.first_name || 'Usuario',
      msg.text
    );
  });

  // ⭐ PRE-CHECKOUT: solo aprobar, NUNCA entregar nada aquí
  bot.on('pre_checkout_query', async (query) => {
    try {
      logger.info(
        { queryId: query.id, userId: query.from.id, payload: query.invoice_payload, amount: query.total_amount },
        '⭐ Pre-checkout recibido'
      );

      // Verificar que el payload existe en Supabase y está pending
      const res = await fetch(
        `${process.env.API_URL}/api/bot/stars/verificar-pending?payload=${encodeURIComponent(query.invoice_payload)}`,
        { headers: { 'x-api-key': process.env.API_KEY } }
      );

      if (!res.ok) {
        logger.error({ queryId: query.id }, 'Pre-checkout: payload no válido');
        await bot.answerPreCheckoutQuery(query.id, false, {
          error_message: 'El pago no es válido o ha expirado. Inténtalo de nuevo con /stars.',
        });
        return;
      }

      const data = await res.json();
      if (!data.valido) {
        logger.error({ queryId: query.id, data }, 'Pre-checkout: payload no válido');
        await bot.answerPreCheckoutQuery(query.id, false, {
          error_message: 'El pago no es válido o ha expirado. Inténtalo de nuevo con /stars.',
        });
        return;
      }

      // ✅ Aprobar el pago (pero NO entregar nada aquí)
      await bot.answerPreCheckoutQuery(query.id, true);
      logger.info({ queryId: query.id }, '⭐ Pre-checkout aprobado');
    } catch (err) {
      logger.error({ err, queryId: query.id }, 'Error en pre-checkout');
      await bot.answerPreCheckoutQuery(query.id, false, {
        error_message: 'Error interno, inténtalo de nuevo.',
      });
    }
  });

  // ⭐ SUCCESSFUL_PAYMENT: aquí SÍ se entrega el código (después del pago confirmado)
  bot.on('successful_payment', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const payment = msg.successful_payment;

    logger.info(
      {
        userId,
        payload: payment.invoice_payload,
        chargeId: payment.telegram_payment_charge_id,
        totalAmount: payment.total_amount,
        currency: payment.currency,
      },
      '⭐ Pago Stars exitoso'
    );

    try {
      // Llamar al backend para que genere y guarde el código de forma atómica
      const res = await fetch(`${process.env.API_URL}/api/bot/stars/procesar-pago`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.API_KEY,
        },
        body: JSON.stringify({
          payload: payment.invoice_payload,
          user_id: String(userId),
          charge_id: payment.telegram_payment_charge_id,
          amount: payment.total_amount,
          currency: payment.currency,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        logger.error({ data, userId }, 'Error procesando pago Stars en backend');
        await enviar(
          bot,
          chatId,
          '⚠️ *PAGO RECIBIDO, PERO HAY UN PROBLEMA*\n\n' +
            'Hemos recibido tu pago, pero hubo un error al generar tu código.\n\n' +
            'Por favor, contacta con soporte con este ID de pago:\n' +
            `\`${payment.telegram_payment_charge_id}\`\n\n` +
            `${SOPORTE}`
        );
        return;
      }

      // ✅ Éxito: enviar el código al usuario
      await enviar(bot, chatId, msgCodigoComprado(data.codigo));
      logger.info({ userId, codigo: data.codigo }, '⭐ Código entregado por Stars');
    } catch (err) {
      logger.error({ err, userId }, 'Error procesando successful_payment');
      await enviar(
        bot,
        chatId,
        '⚠️ *PAGO RECIBIDO, PERO HAY UN PROBLEMA*\n\n' +
          'Contacta con soporte con este ID de pago:\n' +
          `\`${payment.telegram_payment_charge_id}\``
      );
    }
  });

  // Callback queries (LOS BOTONES)
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const username = query.from.username || query.from.first_name || 'Usuario';
    const data = query.data;

    logger.info({ userId, data }, '🔘 Callback query (Botón pulsado)');

    // Quitar el "relojito" de carga del botón
    await bot.answerCallbackQuery(query.id);

    if (data === 'comprar') {
      await procesarComando(bot, chatId, userId, username, 'comprar', null);
    } else if (data === 'ayuda') {
      await procesarComando(bot, chatId, userId, username, 'ayuda', null);
    } else if (data === 'descargar') {
      await procesarDescarga(bot, chatId, userId, username);
    } else if (data === 'install') {
      await procesarInstall(bot, chatId, userId, username);
    } else if (data === 'stars') {
      // ⭐ NUEVO: botón "⭐ Pagar con Stars"
      await enviarFacturaStars(bot, chatId, userId, username);
    }
  });

  return bot;
}

export function getBot() {
  return bot;
}