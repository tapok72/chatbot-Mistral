import TelegramBot from 'node-telegram-bot-api';
import MistralClient from '@mistralai/mistralai';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { SpeechClient } from '@google-cloud/speech';
import cron from 'node-cron';
import createMyLogger from './logger.js';
import { cleanupTempFiles } from './cleanup.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM_PROMPT = `Ты - русскоязычный AI ассистент. Всегда отвечай на русском языке, 
используя правильную грамматику и пунктуацию. Твои ответы должны быть понятными, 
полезными и дружелюбными. Если пользователь пишет на другом языке, всё равно отвечай 
на русском языке.`;

class BotManager {
    constructor() {
        this.bot = null;
        this.retryDelay = 10000;
        this.maxRetryDelay = 60 * 1000;
        this.reconnectTimeout = null;
        this.isReconnecting = false;
        this.mistral = new MistralClient(process.env.MISTRAL_API_KEY);
        this.genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
        this.visionModel = this.genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        this.textModel = this.genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        this.speechClient = new SpeechClient();
        this.userSettings = new Map();
        this.userContexts = new Map();
        this.MAX_CONTEXT_LENGTH = 10;
        this.logger = createMyLogger(false);
        this.setupBot();
    }

    setupBot() {
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
            polling: {
                autoStart: false,
                params: {
                    timeout: 30
                }
            }
        });

        this.bot.on('polling_error', this.handlePollingError.bind(this));
        this.bot.on('error', this.handleError.bind(this));
        
        this.setupMessageHandlers();
    }

    async handlePollingError(error) {
        if (!this.isReconnecting) {
            this.logger.warn(`Ошибка подключения: ${error.code}. Попытка переподключения через ${this.retryDelay / 1000} секунд`);
            await this.scheduleReconnect();
        }
    }

    async handleError(error) {
        if (!this.isReconnecting) {
            this.logger.error(`Общая ошибка бота: ${error.message}`);
            await this.scheduleReconnect();
        }
    }

    async scheduleReconnect() {
        if (this.isReconnecting) return;
        
        clearTimeout(this.reconnectTimeout);
        this.isReconnecting = true;

        this.reconnectTimeout = setTimeout(async () => {
            try {
                this.logger.info('Попытка переподключения...');
                await this.bot.stopPolling();
                await new Promise(resolve => setTimeout(resolve, 1000));
                await this.bot.startPolling();
                
                this.logger.info('Успешное переподключение');
                this.isReconnecting = false;
                this.retryDelay = 10000;
            } catch (error) {
                this.logger.error('Ошибка при переподключении:', error);
                this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
                this.isReconnecting = false;
                await this.scheduleReconnect();
            }
        }, this.retryDelay);
    }

    async handleError(chatId, error, message) {
        this.logger.error(message, error);
        let userMessage = 'Извините, произошла ошибка при обработке вашего запроса.';

        if (error.response?.status === 401) {
            userMessage += ' Проблема с авторизацией в AI сервисах.';
        } else if (error.code === 'ETELEGRAM' || error.code === 'ETIMEDOUT') {
            userMessage += ' Проблема с подключением к Telegram.';
        }

        userMessage += ' Попробуйте позже.';

        try {
            await this.bot.sendMessage(chatId, userMessage);
        } catch (sendError) {
            this.logger.error('Ошибка при отправке сообщения об ошибке:', sendError);
        }
    }

    formatGoogleAIHistory(context) {
        return context.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));
    }

    setupMessageHandlers() {
        // Обработчик команды /model
        this.bot.onText(/\/model/, async (msg) => {
            const chatId = msg.chat.id;
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: 'Mistral AI', callback_data: 'model_mistral' },
                        { text: 'Google AI', callback_data: 'model_google' }
                    ]
                ]
            };

            await this.bot.sendMessage(
                chatId,
                'Выберите модель AI для обработки ваших сообщений:',
                { reply_markup: keyboard }
            );
        });

        // Обработчик callback query
        this.bot.on('callback_query', async (query) => {
            const chatId = query.message.chat.id;
            const model = query.data.split('_')[1];

            this.userSettings.set(chatId, { model });

            await this.bot.answerCallbackQuery(query.id);
            await this.bot.sendMessage(
                chatId,
                `Выбрана модель: ${model === 'mistral' ? 'Mistral AI' : 'Google AI'}`
            );
        });

        // Обработчик команды /start
        this.bot.onText(/\/start/, (msg) => {
            const chatId = msg.chat.id;
            this.userSettings.set(chatId, { model: 'mistral' });

            this.bot.sendMessage(
                chatId,
                'Привет! Я ваш AI ассистент. Я могу:\n\n' +
                '• Отвечать на текстовые сообщения (Mistral AI или Google AI)\n' +
                '• Анализировать изображения (Google AI Vision)\n' +
                '• Обрабатывать голосовые сообщения\n\n' +
                'Используйте /model для выбора модели AI.\n' +
                'Отправьте мне текст, картинку или голосовое сообщение, и я отвечу на русском языке!'
            ).catch(error => {
                this.logger.error('Ошибка при отправке приветственного сообщения:', error);
            });
        });

        // Обработчик команды /reset
        this.bot.onText(/\/reset/, (msg) => {
            const chatId = msg.chat.id;
            this.userContexts.delete(chatId);
            this.bot.sendMessage(chatId, 'Контекст сброшен.');
        });

        // Обработчик голосовых сообщений
        this.bot.on('voice', async (msg) => {
            const chatId = msg.chat.id;

            try {
                await this.bot.sendChatAction(chatId, 'typing');

                const file = await this.bot.getFile(msg.voice.file_id);
                const voiceUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

                const voiceResponse = await fetch(voiceUrl);
                if (!voiceResponse.ok) {
                    throw new Error(`Ошибка при скачивании голоса: ${voiceResponse.status} ${voiceResponse.statusText}`);
                }
                const buffer = await voiceResponse.buffer();

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

                const [speechResponse] = await this.speechClient.recognize(request);
                const transcription = speechResponse.results
                    .map(result => result.alternatives[0].transcript)
                    .join('\n');

                const settings = this.userSettings.get(chatId) || { model: 'mistral' };
                let aiResponse;
                let context = this.userContexts.get(chatId) || [];
                context.push({ role: 'user', content: transcription });
                context = context.slice(-this.MAX_CONTEXT_LENGTH);

                if (settings.model === 'mistral') {
                    const mistralResponse = await this.mistral.chat({
                        model: 'mistral-tiny',
                        messages: [
                            { role: 'system', content: SYSTEM_PROMPT },
                            ...context
                        ],
                        max_tokens: 1000,
                        temperature: 0.7,
                        top_p: 0.9
                    });
                    aiResponse = mistralResponse.choices[0].message.content;
                } else {
                    const formattedHistory = this.formatGoogleAIHistory(context);
                    const chat = this.textModel.startChat({
                        history: formattedHistory,
                    });
                    const result = await chat.sendMessage(transcription);
                    aiResponse = result.response.text();
                }
                context.push({ role: 'assistant', content: aiResponse });
                this.userContexts.set(chatId, context);

                await this.bot.sendMessage(
                    chatId,
                    `🎤 Распознанный текст: "${transcription}"\n\n💬 Ответ: ${aiResponse}`
                );

            } catch (error) {
                this.handleError(chatId, error, 'Ошибка при обработке голосового сообщения:');
            }
        });

        // Обработчик фотографий
        this.bot.on('photo', async (msg) => {
            const chatId = msg.chat.id;

            try {
                await this.bot.sendChatAction(chatId, 'typing');

                const photo = msg.photo[msg.photo.length - 1];
                const file = await this.bot.getFile(photo.file_id);
                const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

                const imageResponse = await fetch(imageUrl);
                const imageBuffer = await imageResponse.buffer();
                const imageBase64 = imageBuffer.toString('base64');

                const prompt = "Опиши подробно, что изображено на этой фотографии на русском языке";

                const result = await this.visionModel.generateContent([prompt, {
                    inlineData: {
                        data: imageBase64,
                        mimeType: 'image/jpeg'
                    }
                }]);
                const description = result.response.text();

                await this.bot.sendMessage(chatId, `🖼 Анализ изображения:\n\n${description}`);

            } catch (error) {
                this.handleError(chatId, error, 'Ошибка при обработке изображения:');
            }
        });

        // Обработчик текстовых сообщений
        this.bot.on('message', async (msg) => {
            if (msg.text && !msg.text.startsWith('/')) {
                const chatId = msg.chat.id;
                const settings = this.userSettings.get(chatId) || { model: 'mistral' };

                let context = this.userContexts.get(chatId) || [];
                context.push({ role: 'user', content: msg.text });
                context = context.slice(-this.MAX_CONTEXT_LENGTH);

                try {
                    await this.bot.sendChatAction(chatId, 'typing');

                    let response;
                    if (settings.model === 'mistral') {
                        const messages = [
                            { role: 'system', content: SYSTEM_PROMPT },
                            ...context,
                        ];
                        const mistralResponse = await this.mistral.chat({
                            model: 'mistral-tiny',
                            messages: messages,
                            max_tokens: 1000,
                            temperature: 0.7,
                            top_p: 0.9
                        });
                        response = `🤖 Mistral AI:\n${mistralResponse.choices[0].message.content}`;
                        context.push({ role: 'assistant', content: mistralResponse.choices[0].message.content });
                    } else {
                        const formattedHistory = this.formatGoogleAIHistory(context);
                        const chat = this.textModel.startChat({
                            history: formattedHistory,
                        });
                        const result = await chat.sendMessage(msg.text);
                        const responseText = result.response.text();
                        response = `🌐 Google AI:\n${responseText}`;
                        context.push({ role: 'assistant', content: responseText });
                    }

                    await this.bot.sendMessage(chatId, response);
                    this.userContexts.set(chatId, context);

                } catch (error) {
                    this.handleError(chatId, error, 'Ошибка при обработке текстового сообщения:');
                }
            }
        });
    }

    async start() {
        try {
            await this.bot.startPolling();
            this.logger.info('Бот успешно запущен');
        } catch (error) {
            this.logger.error('Ошибка при запуске бота:', error);
            await this.scheduleReconnect();
        }
    }
}

// Проверяем наличие необходимых переменных окружения
const requiredEnvVars = [
    'TELEGRAM_BOT_TOKEN',
    'MISTRAL_API_KEY',
    'GOOGLE_AI_API_KEY'
];

function checkRequiredEnvVars(requiredVars) {
    const logger = createMyLogger(false);
    for (const envVar of requiredVars) {
        if (!process.env[envVar]) {
            logger.error(`Ошибка: ${envVar} не установлен в .env файле`);
            process.exit(1);
        }
    }
}
checkRequiredEnvVars(requiredEnvVars);

// Создаем и запускаем бота
const botManager = new BotManager();
botManager.start();