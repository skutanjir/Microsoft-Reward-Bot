/**
 * Logger
 * Structured logging with color coding, file output, and context awareness
 */

import fs from 'fs'
import path from 'path'
import chalk from 'chalk'
import type { LogLevel, LogEntry } from '../types'

export class Logger {
    private logDir: string
    private logFile: string
    private enableFileLogging: boolean
    private enableConsoleLogging: boolean

    constructor(logDir: string = './logs', enableFile: boolean = true, enableConsole: boolean = true) {
        this.logDir = logDir
        this.enableFileLogging = enableFile
        this.enableConsoleLogging = enableConsole

        // Create logs directory
        if (this.enableFileLogging && !fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true })
        }

        // Create timestamped log file
        const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0]
        this.logFile = path.join(this.logDir, `bot-${timestamp}.log`)
    }

    private formatMessage(level: LogLevel, context: string, message: string, data?: any): string {
        const timestamp = new Date().toISOString()
        let formatted = `[${timestamp}] [${level.toUpperCase()}] [${context}] ${message}`

        if (data) {
            formatted += ` | ${JSON.stringify(data)}`
        }

        return formatted
    }

    private getColoredLevel(level: LogLevel): string {
        switch (level) {
            case 'debug':
                return chalk.gray('DEBUG')
            case 'info':
                return chalk.blue('INFO')
            case 'warn':
                return chalk.yellow('WARN')
            case 'error':
                return chalk.red('ERROR')
            case 'critical':
                return chalk.bgRed.white('CRITICAL')
        }
    }

    private log(level: LogLevel, context: string, message: string, data?: any, account?: string, mobile?: boolean): void {
        const logEntry: LogEntry = {
            timestamp: new Date(),
            level,
            context,
            message,
            data,
            account,
            mobile
        }

        // Console output with colors
        if (this.enableConsoleLogging) {
            const timestamp = chalk.gray(logEntry.timestamp.toISOString())
            const levelColored = this.getColoredLevel(level)
            const contextFormatted = chalk.cyan(`[${context}]`)
            const accountInfo = account ? chalk.magenta(`[${account}${mobile ? ' - Mobile' : ''}]`) : ''
            const messageFormatted = message
            const dataFormatted = data ? chalk.dim(JSON.stringify(data)) : ''

            console.log(`${timestamp} ${levelColored} ${contextFormatted} ${accountInfo} ${messageFormatted} ${dataFormatted}`)
        }

        // File output (plain text)
        if (this.enableFileLogging) {
            const formatted = this.formatMessage(level, context, message, data)
            fs.appendFileSync(this.logFile, formatted + '\n')
        }
    }

    debug(context: string, message: string, data?: any, account?: string, mobile?: boolean): void {
        this.log('debug', context, message, data, account, mobile)
    }

    info(context: string, message: string, data?: any, account?: string, mobile?: boolean): void {
        this.log('info', context, message, data, account, mobile)
    }

    warn(context: string, message: string, data?: any, account?: string, mobile?: boolean): void {
        this.log('warn', context, message, data, account, mobile)
    }

    error(context: string, message: string, data?: any, account?: string, mobile?: boolean): void {
        this.log('error', context, message, data, account, mobile)
    }

    critical(context: string, message: string, data?: any, account?: string, mobile?: boolean): void {
        this.log('critical', context, message, data, account, mobile)
    }

    // Convenience method for logging with isMobile boolean
    logWithContext(isMobile: boolean, level: LogLevel, context: string, message: string, data?: any, account?: string): void {
        this.log(level, context, message, data, account, isMobile)
    }
}

// Global logger instance
export const logger = new Logger()
