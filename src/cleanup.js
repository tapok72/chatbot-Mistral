import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEMP_DIR = path.join(__dirname, 'temp');
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

async function cleanupTempFiles() {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.stat(filePath);
      const age = now - stats.mtime.getTime();

      if (age > ONE_WEEK) {
        await fs.unlink(filePath);
        logger.info(`Удален старый временный файл: ${file}`);
      }
    }
    logger.info('Очистка временных файлов завершена');
  } catch (error) {
    logger.error('Ошибка при очистке временных файлов:', error);
  }
}

export { cleanupTempFiles };