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

const SOPORTE = '🕐 Soporte: L-V de 9:00 a 18:00';

let bot;

export function iniciarTelegram() {
  bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

  logger.info('✅ Bot de Telegram conectado');

  // /start
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
      bot,
      msg.chat.id,
      msg.from.id,
      msg.from.username || msg.from.first_name || 'Usuario',
      'codigo',
      null
    );
  });

  // /ayuda
  bot.onText(/\/(ayuda|help)/, async (msg) => {
    await procesarComando(bot, msg.chat.id, msg.from.id, msg.from.username, 'ayuda', null);
  });

  // /install
  bot.onText(/\/(install|instalar)/, async (msg) => {
    await procesarInstall(bot, msg.chat.id, msg.from.id, msg.from.username || msg.from.first_name || 'Usuario');
  });

  // /miscompras
  bot.onText(/\/miscompras/, async (msg) => {
    await procesarComando(bot, msg.chat.id, msg.from.id, msg.from.username, 'miscompras', null);
  });

  // /descargar
  bot.onText(/\/descargar/, async (msg) => {
    await procesarDescarga(bot, msg.chat.id, msg.from.id, msg.from.username || msg.from.first_name || 'Usuario');
  });

  // /stars y /comprar (redirigidos a Stars)
  bot.onText(/\/(stars|comprar)/, async (msg) => {
    await enviarFacturaStars(bot, msg.chat.id, msg.from.id, msg.from.username || msg.from.first_name || 'Usuario');
  });

  // Mensajes de texto libre
  bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return;
    if (!msg.text) return;

    await procesarMensaje(
      bot,
      msg.chat.id,
      msg.from.id,
      msg.from.username || msg.from.first_name || 'Usuario',
      msg.text
    );
  });

  // ⭐ PRE-CHECKOUT — solo validar y aprobar. NO se entrega nada aquí.
  bot.on('pre_checkout_query', async (query) => {
    let respondido = false;
    try {
      const userId = query.from?.id;
      const payload = query.invoice_payload;

      logger.info(
        { queryId: query.id, userId, payload, amount: query.total_amount, currency: query.currency },
        '⭐ Pre-checkout recibido'
      );

      if (!userId || !payload) {
        await bot.answerPreCheckoutQuery(query.id, false, {
          error_message: 'El pago no es válido. Inténtalo de nuevo con /stars.',
        });
        respondido = true;
        return;
      }

      // Moneda: Stars = XTR
      if (query.currency && query.currency !== 'XTR') {
        await bot.answerPreCheckoutQuery(query.id, false, {
          error_message: 'Moneda no soportada.',
        });
        respondido = true;
        return;
      }

      // Verificar pending Y que pertenece a este usuario
      let data = null;
      try {
        const res = await fetch(
          `${process.env.API_URL}/api/bot/stars/verificar-pending?payload=${encodeURIComponent(payload)}&user_id=${encodeURIComponent(userId)}`,
          {
            headers: { 'x-api-key': process.env.API_KEY },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (res.ok) data = await res.json();
        else logger.error({ status: res.status, queryId: query.id }, 'verificar-pending: respuesta no OK');
      } catch (err) {
        logger.error({ err, queryId: query.id }, 'verificar-pending: error de red');
      }

      if (!data?.valido) {
        await bot.answerPreCheckoutQuery(query.id, false, {
          error_message: 'El pago no es válido o ha expirado. Inténtalo de nuevo con /stars.',
        });
        respondido = true;
        return;
      }

      // Verificación extra: el amount de Stars que mandó Telegram coincide con lo esperado
      if (typeof data.amount_stars === 'number' && data.amount_stars !== query.total_amount) {
        logger.error(
          { queryId: query.id, esperado: data.amount_stars, recibido: query.total_amount },
          'pre-checkout: amount no coincide'
        );
        await bot.answerPreCheckoutQuery(query.id, false, {
          error_message: 'El importe del pago no coincide. Inténtalo de nuevo con /stars.',
        });
        respondido = true;
        return;
      }

      await bot.answerPreCheckoutQuery(query.id, true);
      respondido = true;
      logger.info({ queryId: query.id }, '⭐ Pre-checkout aprobado');
    } catch (err) {
      logger.error({ err, queryId: query.id }, 'Error en pre-checkout');
      if (!respondido) {
        try {
          await bot.answerPreCheckoutQuery(query.id, false, {
            error_message: 'Error interno, inténtalo de nuevo.',
          });
        } catch (e) {}
      }
    }
  });

  // ⭐ SUCCESSFUL_PAYMENT — aquí sí se entrega el código
  bot.on('successful_payment', async (msg) => {
    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    const payment = msg.successful_payment;

    if (
      !chatId ||
      !userId ||
      !payment ||
      !payment.invoice_payload ||
      !payment.telegram_payment_charge_id
    ) {
      logger.error({ msg }, 'successful_payment malformado');
      return;
    }

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

    const chargeId = payment.telegram_payment_charge_id;
    let data = null;
    let ok = false;

    try {
      const res = await fetch(`${process.env.API_URL}/api/bot/stars/procesar-pago`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.API_KEY,
        },
        body: JSON.stringify({
          payload: payment.invoice_payload,
          user_id: String(userId),
          charge_id: chargeId,
          amount: payment.total_amount,
          currency: payment.currency,
        }),
        signal: AbortSignal.timeout(15000),
      });
      data = await res.json().catch(() => null);
      ok = res.ok && !!data?.success;
      if (!ok) logger.error({ status: res.status, data, userId }, 'procesar-pago: fallo');
    } catch (err) {
      logger.error({ err, userId }, 'procesar-pago: error de red');
    }

    if (!ok) {
      // Mensaje directo (NO usar enviar() para que el error no se silencie)
      try {
        await bot.sendMessage(
          chatId,
          '⚠️ *PAGO RECIBIDO, PERO HAY UN PROBLEMA*\n\n' +
            'Hemos recibido tu pago, pero hubo un error al generar tu código.\n\n' +
            'Por favor, contacta con soporte con este ID de pago:\n' +
            `\`${chargeId}\`\n\n` +
            `${SOPORTE}`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        logger.error({ err: e, userId, chargeId }, 'No se pudo avisar al usuario del fallo');
      }
      return;
    }

    // Enviar el código
    try {
      await bot.sendMessage(chatId, msgCodigoComprado(data.codigo), { parse_mode: 'Markdown' });
      logger.info({ userId, codigo: data.codigo }, '⭐ Código entregado por Stars');
    } catch (e) {
      logger.error({ err: e, userId, chargeId, codigo: data.codigo }, 'Fallo enviando código al usuario');
      // Intento de aviso alternativo sin Markdown
      try {
        await bot.sendMessage(
          chatId,
          `✅ Pago recibido. Tu código es: ${data.codigo}\n\nSi no lo ves bien, contacta con soporte indicando: ${chargeId}`
        );
      } catch (e2) {}
    }
  });

  // Callback queries (botones)
  bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat?.id;
    const userId = query.from?.id;
    const username = query.from?.username || query.from?.first_name || 'Usuario';
    const data = query.data;

    logger.info({ userId, data }, '🔘 Callback query (Botón pulsado)');

    try {
      await bot.answerCallbackQuery(query.id);
    } catch (e) {
      logger.warn({ err: e }, 'answerCallbackQuery falló');
    }

    if (!chatId || !userId) return;

    if (data === 'comprar' || data === 'stars') {
      await enviarFacturaStars(bot, chatId, userId, username);
    } else if (data === 'ayuda') {
      await procesarComando(bot, chatId, userId, username, 'ayuda', null);
    } else if (data === 'descargar') {
      await procesarDescarga(bot, chatId, userId, username);
    } else if (data === 'install') {
      await procesarInstall(bot, chatId, userId, username);
    }
  });

  return bot;
}

export function getBot() {
  return bot;
}