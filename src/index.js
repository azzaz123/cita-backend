import dotenv from 'dotenv';
dotenv.config();
process.env.NTBA_FIX_350 = true;

import express from 'express';
import { iniciarTelegram } from './telegram.js';
import { logger } from './logger.js';

console.log('🚀 Iniciando bot de Telegram...');
iniciarTelegram();

// Mini servidor HTTP (solo healthcheck; ya no hay notify-codigo)
const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.json({ status: 'online', service: 'telegram-bot' }));

const PORT = process.env.PORT || process.env.PORT_BOT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Servidor interno del bot escuchando en puerto ${PORT}`);
});

process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled'));
process.on('uncaughtException', (err) => logger.error({ err }, 'Uncaught'));