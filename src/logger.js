import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import fs from 'node:fs';
import { format } from 'winston';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const logDir = path.join(__dirname, 'logs');

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

function createTransports(isReconnecting) {
    const ignoreReconnectErrors = format((info) => {
        if (isReconnecting && 
            (info.message.includes('ETELEGRAM') || 
             info.message.includes('ETIMEDOUT') || 
             info.message.includes('Попытка переподключения'))) {
            return false;
        }
        return info;
    });

    return [
        new DailyRotateFile({
            filename: path.join(logDir, 'error-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '5m',
            maxFiles: '7d',
            level: 'error',
            format: winston.format.combine(
                ignoreReconnectErrors(),
                winston.format.timestamp(),
                winston.format.json()
            )
        }),
        new DailyRotateFile({
            filename: path.join(logDir, 'combined-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            format: winston.format.combine(
                ignoreReconnectErrors(),
                winston.format.timestamp(),
                winston.format.json()
            )
        })
    ];
}

export default function createMyLogger(isReconnecting) {
    const logger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss'
            }),
            winston.format.json()
        ),
        transports: createTransports(isReconnecting)
    });

    if (process.env.NODE_ENV !== 'production') {
        logger.add(new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }));
    }

    return logger;
}