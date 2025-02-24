import TelegramBot from 'node-telegram-bot-api';
import MistralClient from '@mistralai/mistralai';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import path from 'path';
import FormData from 'form-data';
import { TextServiceClient } from '@google-ai/generativelanguage';
import { GoogleAuth } from 'google-auth-library';
import { SpeechClient } from '@google-cloud/speech';
import cron from 'node-cron';
import logger from './logger.js';
import { cleanupTempFiles } from './cleanup.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Проверка наличия всех необходимых токенов
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'MISTRAL_API_KEY',
  'GOOGLE_AI_API_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Ошибка: ${envVar} не установлен в .env файле`);
    process.exit(1);
  }
}

// Инициализация клиентов
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
  polling: true,
  request: {
    timeout: 30000,
    retry: 3
  }
});

const mistral = new MistralClient(process.env.MISTRAL_API_KEY);
const googleAI = new TextServiceClient({
  authClient: new GoogleAuth().fromAPIKey(process.env.GOOGLE_AI_API_KEY),
});

const speechClient = new SpeechClient({
  auth: new GoogleAuth().fromAPIKey(process.env.GOOGLE_AI_API_KEY)
});

// Создание необходимых директорий
const tempDir = path.join(__dirname, 'temp');
const logsDir = path.join(__dirname, 'logs');

try {
  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
} catch (error) {
  logger.error('Ошибка при создании директорий:', error);
}

// Планировщик очистки временных файлов (каждое воскресенье в 00:00)
cron.schedule('0 0 * * 0', () => {
  cleanupTempFiles();
});

// Хранение настроек пользователей
const userSettings = new Map();

// Системные промпты
const SYSTEM_PROMPT = `Ты - русскоязычный AI ассистент. Всегда отвечай на русском языке, 
используя правильную грамматику и пунктуацию. Твои ответы должны быть понятными, 
полезными и дружелюбными. Если пользователь пишет на другом языке, всё равно отвечай 
на русском языке.`;

// Обработка ошибок подключения
bot.on('polling_error', (error) => {
  logger.error('Ошибка подключения к Telegram:', error);
  if (error.code === 'ETELEGRAM') {
    logger.error('Проверьте правильность токена и доступность API Telegram');
  }
  setTimeout(() => {
    logger.info('Попытка переподключения...');
    bot.startPolling();
  }, 5000);
});

bot.on('error', (error) => {
  logger.error('Общая ошибка бота:', error);
});

// Команда для выбора модели
bot.onText(/\/model/, async (msg) => {
  const chatId = msg.chat.id;
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Mistral AI', callback_data: 'model_mistral' },
        { text: 'Google AI', callback_data: 'model_google' }
      ]
    ]
  };
  
  await bot.sendMessage(
    chatId,
    'Выберите модель AI для обработки ваших сообщений:',
    { reply_markup: keyboard }
  );
});

// Обработка выбора модели
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const model = query.data.split('_')[1];
  
  userSettings.set(chatId, { model });
  
  await bot.answerCallbackQuery(query.id);
  await bot.sendMessage(
    chatId,
    `Выбрана модель: ${model === 'mistral' ? 'Mistral AI' : 'Google AI'}`
  );
});

// Приветственное сообщение
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userSettings.set(chatId, { model: 'mistral' }); // По умолчанию используем Mistral
  
  bot.sendMessage(
    chatId,
    'Привет! Я ваш AI ассистент. Я могу:\n\n' +
    '• Отвечать на текстовые сообщения (Mistral AI или Google AI)\n' +
    '• Анализировать изображения (Google AI Vision)\n' +
    '• Обрабатывать голосовые сообщения\n\n' +
    'Используйте /model для выбора модели AI.\n' +
    'Отправьте мне текст, картинку или голосовое сообщение, и я отвечу на русском языке!'
  ).catch(error => {
    logger.error('Ошибка при отправке приветственного сообщения:', error);
  });
});

// Обработка голосовых сообщений
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    await bot.sendChatAction(chatId, 'typing');
    
    // Получаем информацию о голосовом файле
    const file = await bot.getFile(msg.voice.file_id);
    const voiceUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    // Скачиваем файл
    const voiceResponse = await fetch(voiceUrl);
    const buffer = await voiceResponse.buffer();
    
    // Сохраняем во временный файл
    const tempFile = path.join(tempDir, `voice_${Date.now()}.ogg`);
    await fs.writeFile(tempFile, buffer);
    
    // Конвертируем голос в текст через Google Speech-to-Text
    const audio = {
      content: buffer.toString('base64')
    };

    const config = {
      encoding: 'OGG_OPUS',
      sampleRateHertz: 48000,
      languageCode: 'ru-RU',
    };

    const request = {
      audio: audio,
      config: config,
    };

    const [speechResponse] = await speechClient.recognize(request);
    const transcription = speechResponse.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');

    // Получаем ответ от выбранной модели
    const settings = userSettings.get(chatId) || { model: 'mistral' };
    let aiResponse;

    if (settings.model === 'mistral') {
      const mistralResponse = await mistral.chat({
        model: 'mistral-tiny',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: transcription }
        ],
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9
      });
      aiResponse = mistralResponse.choices[0].message.content;
    } else {
      const googleResponse = await googleAI.generateText({
        model: 'models/text-bison-001',
        prompt: { text: transcription }
      });
      aiResponse = googleResponse[0]?.candidates[0]?.output || 'Извините, не удалось сгенерировать ответ.';
    }

    // Отправляем распознанный текст и ответ
    await bot.sendMessage(
      chatId,
      `🎤 Распознанный текст: "${transcription}"\n\n💬 Ответ: ${aiResponse}`
    );
    
    // Удаляем временный файл
    await fs.unlink(tempFile);
    
  } catch (error) {
    logger.error('Ошибка при обработке голосового сообщения:', error);
    await bot.sendMessage(
      chatId,
      'Произошла ошибка при обработке голосового сообщения. Пожалуйста, попробуйте позже.'
    );
  }
});

// Обработка изображений с использованием Google AI Vision
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    await bot.sendChatAction(chatId, 'typing');
    
    // Получаем файл наилучшего качества
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    // Анализируем изображение через Google AI Vision
    const result = await googleAI.generateText({
      model: 'models/imagetext-001',
      prompt: {
        text: "Опиши подробно, что изображено на этой фотографии на русском языке",
        image: { url: imageUrl }
      }
    });

    const description = result[0]?.candidates[0]?.output || 'Извините, не удалось проанализировать изображение.';

    // Отправляем описание изображения
    await bot.sendMessage(chatId, `🖼 Анализ изображения:\n\n${description}`);
    
  } catch (error) {
    logger.error('Ошибка при обработке изображения:', error);
    await bot.sendMessage(
      chatId,
      'Произошла ошибка при анализе изображения. Пожалуйста, попробуйте позже.'
    );
  }
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    const chatId = msg.chat.id;
    const settings = userSettings.get(chatId) || { model: 'mistral' };

    try {
      await bot.sendChatAction(chatId, 'typing');

      let response;
      if (settings.model === 'mistral') {
        const mistralResponse = await mistral.chat({
          model: 'mistral-tiny',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: msg.text }
          ],
          max_tokens: 1000,
          temperature: 0.7,
          top_p: 0.9
        });
        response = `🤖 Mistral AI:\n${mistralResponse.choices[0].message.content}`;
      } else {
        const googleResponse = await googleAI.generateText({
          model: 'models/text-bison-001',
          prompt: { text: msg.text }
        });
        response = `🌐 Google AI:\n${googleResponse[0]?.candidates[0]?.output || 'Нет ответа'}`;
      }

      await bot.sendMessage(chatId, response);
    } catch (error) {
      logger.error('Ошибка при обработке сообщения:', error);
      
      let errorMessage = 'Извините, произошла ошибка при обработке вашего запроса. ';
      
      if (error.response?.status === 401) {
        errorMessage += 'Проблема с авторизацией в AI сервисах. ';
      } else if (error.code === 'ETELEGRAM') {
        errorMessage += 'Проблема с подключением к Telegram. ';
      }
      
      errorMessage += 'Попробуйте позже.';
      
      try {
        await bot.sendMessage(chatId, errorMessage);
      } catch (sendError) {
        logger.error('Ошибка при отправке сообщения об ошибке:', sendError);
      }
    }
  }
});