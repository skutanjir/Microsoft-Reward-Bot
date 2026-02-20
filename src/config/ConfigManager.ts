/**
 * Configuration Manager
 * Loads and validates configuration from config.json with Zod schema validation
 */

import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import type { BotConfig, Account } from '../types'

// Zod schemas for validation
const SpeedSettingsSchema = z.object({
    minDelay: z.number().min(0).default(5000),
    maxDelay: z.number().min(0).default(15000)
})

const ProxyConfigSchema = z.object({
    protocol: z.enum(['http', 'https', 'socks4', 'socks5']),
    host: z.string(),
    port: z.number(),
    username: z.string().optional(),
    password: z.string().optional()
})

const AccountSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
    proxy: ProxyConfigSchema.optional(),
    enabled: z.boolean().optional(),
    disabled: z.boolean().optional()
})

const SearchSettingsSchema = z.object({
    desktopSearches: z.number().min(0).max(100),
    mobileSearches: z.number().min(0).max(100),
    searchOrder: z.enum(['desktop-first', 'mobile-first']),
    retryMobileSearchAmount: z.number().min(0).max(10)
})

const SelectorLearningConfigSchema = z.object({
    enabled: z.boolean(),
    persistencePath: z.string(),
    autoMutate: z.boolean(),
    trainingMode: z.boolean(),
    confidenceThreshold: z.number().min(0).max(100)
})

const AntiDetectionConfigSchema = z.object({
    timingProfile: z.enum(['conservative', 'normal', 'aggressive']),
    enableMouseMovement: z.boolean(),
    enableScrollVariation: z.boolean(),
    enableHoverBehavior: z.boolean()
})

const RecoveryConfigSchema = z.object({
    maxRetries: z.number().min(1).max(10),
    enableAutoRecovery: z.boolean(),
    fallbackToManual: z.boolean()
})

const DashboardConfigSchema = z.object({
    enabled: z.boolean(),
    port: z.number().min(1024).max(65535),
    auth: z.object({
        username: z.string(),
        password: z.string()
    })
})

const WebhookConfigSchema = z.object({
    enabled: z.boolean(),
    discordWebhookUrl: z.union([z.string().url(), z.literal('')]).optional()
})

const BotConfigSchema = z.object({
    accounts: z.array(AccountSchema).min(1),
    sessionPath: z.string(),
    headless: z.boolean(),
    workers: z.number().min(1).max(1000),
    searchSettings: SearchSettingsSchema,
    selectorLearning: SelectorLearningConfigSchema,
    antiDetection: AntiDetectionConfigSchema,
    recovery: RecoveryConfigSchema,
    dashboard: DashboardConfigSchema,
    webhooks: WebhookConfigSchema,
    baseURL: z.string().url(),
    maxAccounts: z.number().min(0).optional(),
    speedSettings: SpeedSettingsSchema.default({ minDelay: 5000, maxDelay: 15000 })
})

export class ConfigManager {
    private config: BotConfig

    constructor(configPath: string = './config.json') {
        this.config = this.loadConfig(configPath)
    }

    private loadConfig(configPath: string): BotConfig {
        // Check if config file exists
        if (!fs.existsSync(configPath)) {
            throw new Error(`Configuration file not found: ${configPath}. Please copy config.example.json to config.json`)
        }

        // Read and parse JSON
        const rawConfig = fs.readFileSync(configPath, 'utf-8')
        let parsedConfig: any

        try {
            parsedConfig = JSON.parse(rawConfig)
        } catch (error) {
            throw new Error(`Invalid JSON in configuration file: ${error instanceof Error ? error.message : String(error)}`)
        }

        // Validate with Zod
        const validation = BotConfigSchema.safeParse(parsedConfig)

        if (!validation.success) {
            const errors = validation.error.format()
            console.error('Configuration validation failed:', JSON.stringify(errors, null, 2))
            throw new Error('Configuration validation failed. Check the errors above.')
        }

        // Additional validations
        const config = validation.data

        // Ensure session path exists
        if (!fs.existsSync(config.sessionPath)) {
            fs.mkdirSync(config.sessionPath, { recursive: true })
        }

        // Ensure selector persistence directory exists
        if (config.selectorLearning.enabled) {
            const dbDir = path.dirname(config.selectorLearning.persistencePath)
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true })
            }
        }

        // Filter accounts: must be explicitly enabled and NOT disabled
        config.accounts = config.accounts.filter(acc => {
            const isEnabled = acc.enabled === true // Default to false if undefined/missing
            const isNotDisabled = acc.disabled !== true // Default to false if undefined
            return isEnabled && isNotDisabled
        })

        if (config.accounts.length === 0) {
            throw new Error('No enabled accounts found in configuration')
        }

        // Limit accounts if maxAccounts is set
        if (config.maxAccounts && config.maxAccounts > 0) {
            config.accounts = config.accounts.slice(0, config.maxAccounts)
        }

        return config
    }

    getConfig(): BotConfig {
        return this.config
    }

    getAccounts(): Account[] {
        return this.config.accounts
    }

    isHeadless(): boolean {
        return this.config.headless
    }

    getWorkers(): number {
        return Math.min(this.config.workers, this.config.accounts.length)
    }

    isSelectorLearningEnabled(): boolean {
        return this.config.selectorLearning.enabled
    }

    isDashboardEnabled(): boolean {
        return this.config.dashboard.enabled
    }

    getBaseURL(): string {
        return this.config.baseURL
    }

    getAntiDetectionProfile(): 'conservative' | 'normal' | 'aggressive' {
        return this.config.antiDetection.timingProfile
    }
}
