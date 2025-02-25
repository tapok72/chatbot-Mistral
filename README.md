# Telegram Бот с Mistral AI

Этот бот использует Mistral AI для генерации ответов на сообщения пользователей в Telegram.

## Настройка

1. Создайте нового бота в Telegram через [@BotFather](https://t.me/BotFather) и получите токен
2. Получите API ключ от [Mistral AI](https://mistral.ai/)
3. Создайте файл `.env` и добавьте ваши токены:
   ```
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   MISTRAL_API_KEY=your_mistral_api_key
   GOOGLE_AI_API_KEY=your_google_api_key
   ```

## Запуск

```bash
npm install
npm run dev
```

## Использование

1. Найдите вашего бота в Telegram по имени
2. Отправьте команду `/start` для начала работы
3. Отправляйте любые сообщения, и бот будет отвечать, используя Mistral AI
4. Отвечать на команды (/start, /model, /reset)
