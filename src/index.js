import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { iniciarTelegram, getBot } from './telegram.js';
import { enviar } from './handlers.js';
import { logger } from './logger.js';

console.log('🚀 Iniciando bot de Telegram...');
iniciarTelegram();

// ─── Mini servidor HTTP para recibir avisos del Server 2 ───
const app = express();
app.use(express.json());

app.post('/api/notify-codigo', async (req, res) => {
  console.log('\n========================================');
  console.log('🚨 [BOT HTTP] ¡Petición recibida del Server 2!');
  console.log('   Headers x-api-key:', req.headers['x-api-key'] ? 'SÍ' : 'NO');
  console.log('   Body recibido:', req.body);

  const { user_id, codigo } = req.body;
  const apiKey = req.headers['x-api-key'];

  if (apiKey !== process.env.API_KEY) {
    console.error('   ❌ [BOT HTTP] API KEY INVÁLIDA. Revisa el .env del bot y del server.');
    return res.status(401).json({ error: 'No autorizado' });
  }

  const bot = getBot();
  if (!bot) {
    console.error('   ❌ [BOT HTTP] El bot de Telegram no está inicializado.');
    return res.status(500).json({ error: 'Bot no listo' });
  }

  try {
    console.log(`   📨 Enviando mensaje a user_id: ${user_id} con código: ${codigo}`);
    
    const msg = `✅ *PAGO CONFIRMADO*\n\n¡Gracias por tu compra!\n\nTu código PREMIUM es:\n\n━━━━━━━━━━━━━━━━━━━━━━\n    *${codigo}*\n━━━━━━━━━━━━━━━━━━━━━━\n\n▸ Válido por 3 meses desde su activación\n▸ Úsalo en la app para activar\n\n🕐 Soporte: L-V de 9:00 a 18:00`;
    
    await bot.sendMessage(user_id, msg, { parse_mode: 'Markdown' });
    
    console.log('   ✅ [BOT HTTP] ¡Mensaje enviado a Telegram con éxito!');
    console.log('========================================\n');
    res.json({ success: true });
    
  } catch (err) {
    console.error('   ❌ [BOT HTTP] ERROR al enviar el mensaje por Telegram:', err.message);
    console.log('========================================\n');
    res.status(500).json({ error: err.message });
  }
});
const PORT = process.env.PORT_BOT || 8080;
app.listen(PORT, () => {
  logger.info(`🚀 Servidor interno del bot escuchando en http://localhost:${PORT}`);
});

process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled'));
process.on('uncaughtException', (err) => logger.error({ err }, 'Uncaught'));