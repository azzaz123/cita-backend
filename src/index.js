import dotenv from 'dotenv';
dotenv.config();
process.env.NTBA_FIX_350 = true;

import express from 'express';
import wokeDyno from 'woke-dyno'; // 1. 导入
import { iniciarTelegram } from './telegram.js';
import { logger } from './logger.js';

console.log('🚀 Iniciando bot de Telegram...');
iniciarTelegram();

const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.json({ status: 'online', service: 'telegram-bot' }));

const PORT = process.env.PORT || process.env.PORT_BOT || 8080;

// 2. 定义 Render 给你的公网 URL（必须是你实际部署后的地址）
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://tu-app.onrender.com';

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Servidor interno del bot escuchando en puerto ${PORT}`);

  // 3. 在 listen 回调里启动，确保服务已经在运行
  const dynoWaker = wokeDyno(SELF_URL);
  dynoWaker.start();
  logger.info(`💓 Woke-dyno iniciado, ping a: ${SELF_URL}`);
});

process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled'));
process.on('uncaughtException', (err) => logger.error({ err }, 'Uncaught'));