import TelegramBot from 'node-telegram-bot-api';
import { logger } from './logger.js';
import { procesarComando, procesarMensaje } from './handlers.js';

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

  // /miscompras
  bot.onText(/\/miscompras/, async (msg) => {
    await procesarComando(bot, msg.chat.id, msg.from.id, msg.from.username, 'miscompras', null);
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
    }
  });

  return bot;
}

bot.onText(/\/descargar/, async (msg) => {
  await procesarDescarga(
    bot,
    msg.chat.id,
    msg.from.id,
    msg.from.username || msg.from.first_name || 'Usuario'
  );
});

// Y en callback_query, añade el caso 'descargar':
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const username = query.from.username || query.from.first_name || 'Usuario';
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  if (data === 'comprar') {
    await procesarComando(bot, chatId, userId, username, 'comprar', null);
  } else if (data === 'ayuda') {
    await procesarComando(bot, chatId, userId, username, 'ayuda', null);
  } else if (data === 'descargar') {
    await procesarDescarga(bot, chatId, userId, username);
  }
});
export function getBot() {
  return bot;
}