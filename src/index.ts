/**
 * Main Entry Point
 * Execution engine orchestrator for Microsoft Rewards Automation Platform
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'path'

import { ConfigManager } from './config/ConfigManager'
import { Logger } from './logging/Logger'
import { Utils } from './util/Utils'

import type { ExecutionContext, Account, AccountStats } from './types'
import { DashboardService } from './services/DashboardService'
import { ActivityRunner } from './services/ActivityRunner'

// Async local storage for execution context
const executionContext = new AsyncLocalStorage<ExecutionContext>()

/**
 * Get current execution context
 */
export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) {
        throw new Error('No execution context available')
    }
    return context
}

/**
 * Main Bot Class
 */
class MicrosoftRewardsBot {
    public logger: Logger
    public config: ConfigManager
    public utils: Utils

    // Shared selector intelligence (kept for SelectorSeeder initialization)
    private _selectorBank!: any

    // Dynamic imports (stored for worker creation)
    private BrowserManagerClass!: any
    private SessionManagerClass!: any
    private LoginManagerClass!: any

    constructor() {
        this.logger = new Logger()
        this.config = new ConfigManager()
        this.utils = new Utils()

        this.logger.info('BOT', 'Microsoft Rewards Automation Platform initialized')
        this.logger.info('BOT', `Loaded ${this.config.getAccounts().length} accounts`)
        this.logger.info('BOT', `Running in ${this.config.isHeadless() ? 'HEADLESS' : 'HEADED'} mode`)
    }

    /**
     * Initialize bot and dependencies
     */
    async initialize(): Promise<void> {
        this.logger.info('BOT', 'Initializing bot dependencies...')

        // Dynamic imports for browser components
        const { BrowserManager } = await import('./browser/BrowserManager')
        const { SessionManager } = await import('./browser/SessionManager')
        const { LoginManager } = await import('./browser/LoginManager')

        // Store classes for per-worker instantiation
        this.BrowserManagerClass = BrowserManager
        this.SessionManagerClass = SessionManager
        this.LoginManagerClass = LoginManager

        // Dynamic imports for selector intelligence
        const { SelectorPersistence } = await import('./selectors/SelectorPersistence')
        const { SelectorBank } = await import('./selectors/SelectorBank')
        const { SelectorSeeder } = await import('./selectors/SelectorSeeder')

        // Initialize Selector Intelligence
        const dbPath = path.join(process.cwd(), 'selectors.sqlite')
        const persistence = new SelectorPersistence(this.logger, dbPath)
        this._selectorBank = new SelectorBank(this.logger, persistence)

        // Seed initial selectors if bank is empty
        SelectorSeeder.seed(this._selectorBank)

        this.logger.info('BOT', 'Bot initialization complete')
    }

    /**
     * Run bot execution with concurrent workers
     */
    async run(): Promise<void> {
        const runStartTime = Date.now()
        this.logger.info('BOT', '='.repeat(80))
        this.logger.info('BOT', 'STARTING MICROSOFT REWARDS AUTOMATION')
        this.logger.info('BOT', '='.repeat(80))

        const accounts = this.config.getAccounts()
        const workerCount = this.config.getWorkers()

        this.logger.info('BOT', `Processing ${accounts.length} accounts with ${workerCount} concurrent worker(s)`)

        const allStats = await this.runWithWorkers(accounts, workerCount)

        const duration = Date.now() - runStartTime
        this.logSummary(allStats)
        this.logger.info('BOT', '='.repeat(80))
        this.logger.info('BOT', `EXECUTION COMPLETE - Duration: ${this.utils.formatDuration(duration)}`)
        this.logger.info('BOT', '='.repeat(80))
    }

    /**
     * Run accounts concurrently using async worker pool.
     * Each worker gets its own Chrome instance (BrowserManager, SessionManager, LoginManager).
     * Accounts are processed in batches of `workerCount` to limit concurrency.
     */
    private async runWithWorkers(accounts: Account[], workerCount: number): Promise<AccountStats[]> {
        const allStats: AccountStats[] = []

        // Process accounts in batches of `workerCount`
        for (let batchStart = 0; batchStart < accounts.length; batchStart += workerCount) {
            const batch = accounts.slice(batchStart, batchStart + workerCount)
            const batchNum = Math.floor(batchStart / workerCount) + 1
            const totalBatches = Math.ceil(accounts.length / workerCount)

            this.logger.info('BOT', `--- Batch ${batchNum}/${totalBatches} (${batch.length} worker(s)) ---`)

            // Run all accounts in this batch concurrently
            const results = await Promise.allSettled(
                batch.map((account, idx) => this.processAccount(account, batchStart + idx))
            )

            // Collect stats from results
            for (let i = 0; i < results.length; i++) {
                const result = results[i]
                if (result.status === 'fulfilled') {
                    allStats.push(result.value)
                } else {
                    allStats.push({
                        email: batch[i].email,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        duration: 0,
                        success: false,
                        tasksCompleted: 0,
                        tasksFailed: 0,
                        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
                    })
                }
            }
        }

        return allStats
    }

    /**
     * Process a single account with its own isolated Chrome instance.
     * Each worker has independent browser, session, and login managers.
     */
    private async processAccount(account: Account, workerIdx: number): Promise<AccountStats> {
        const wId = `W${workerIdx}`
        this.logger.info(wId, `Starting worker for: ${account.email}`)

        const accountStats: AccountStats = {
            email: account.email,
            initialPoints: 0,
            finalPoints: 0,
            collectedPoints: 0,
            duration: 0,
            success: false,
            tasksCompleted: 0,
            tasksFailed: 0
        }

        const startTime = Date.now()

        // Create per-worker isolated instances
        const browserManager = new this.BrowserManagerClass(this.logger, this.utils)
        const sessionManager = new this.SessionManagerClass(this.logger, this.config.getConfig().sessionPath)
        const loginManager = new this.LoginManagerClass(this.logger, this.utils)

        try {
            // Desktop flow
            const desktopContext: ExecutionContext = {
                account,
                isMobile: false,
                sessionStart: new Date(),
                initialPoints: 0,
                currentPoints: 0
            }

            await executionContext.run(desktopContext, async () => {
                await this.executeDesktopFlow(account, browserManager, sessionManager, loginManager, wId)
            })

            // Mobile flow
            const mobileContext: ExecutionContext = {
                account,
                isMobile: true,
                sessionStart: new Date(),
                initialPoints: 0,
                currentPoints: 0
            }

            await executionContext.run(mobileContext, async () => {
                await this.executeMobileFlow(account, browserManager, sessionManager, loginManager, wId)
            })

            accountStats.success = true
            accountStats.duration = Date.now() - startTime

            this.logger.info(wId, `Completed: ${account.email} - Duration: ${this.utils.formatDuration(accountStats.duration)}`)
        } catch (error) {
            accountStats.success = false
            accountStats.error = error instanceof Error ? error.message : String(error)
            accountStats.duration = Date.now() - startTime

            this.logger.error(wId, `Failed: ${account.email}`, { error: accountStats.error })
        } finally {
            await browserManager.closeBrowser().catch(() => { })
            this.logger.info(wId, '='.repeat(40))
        }

        return accountStats
    }

    /**
     * Execute desktop automation flow
     */
    private async executeDesktopFlow(
        account: Account,
        browserManager: any,
        sessionManager: any,
        loginManager: any,
        wId: string
    ): Promise<void> {
        this.logger.info(wId, `[DESKTOP] Starting desktop flow for ${account.email}`)

        // Launch desktop browser
        await browserManager.launchBrowser(this.config.isHeadless(), false)

        // Create browser context
        const session = await browserManager.createContext(account, false)

        try {
            // Create page
            const page = await browserManager.createPage(session.context)

            // Try to restore session first
            const hasSession = await sessionManager.restoreSession(account, session.context, false)

            if (hasSession) {
                this.logger.info(wId, '[DESKTOP] Session found, verifying login status...')
                await browserManager.goto(page, 'https://rewards.bing.com/')
                const isLoggedIn = await loginManager.isLoggedIn(page)

                if (!isLoggedIn) {
                    this.logger.warn(wId, '[DESKTOP] Session expired, performing fresh login')
                    await loginManager.login(page, account)
                } else {
                    this.logger.info(wId, '[DESKTOP] Session valid, skipping login')
                }
            } else {
                this.logger.info(wId, '[DESKTOP] No session found, performing login')
                await loginManager.login(page, account)
            }

            // Save session after successful login/verification
            await sessionManager.saveSession(account, session.context, false)

            // --- API-Based Desktop Flow ---

            // Get cookies and fingerprint for API calls
            const cookies = await session.context.cookies()
            const fingerprint = session.fingerprint

            // Initialize dashboard service and get token
            const dashService = new DashboardService(this.logger)
            const requestToken = await dashService.getRequestToken(page)

            if (!requestToken) {
                this.logger.warn(wId, '[DESKTOP] RequestVerificationToken not found, API activities may fail')
            }

            // Fetch dashboard data via API
            this.logger.info(wId, '[DESKTOP] Fetching dashboard data...')
            const dashboardData = await dashService.getDashboardData(cookies, fingerprint, page)

            const currentPoints = dashboardData.userStatus.availablePoints
            this.logger.info(wId, `[DESKTOP] Current points: ${currentPoints}`)

            // Run activities via API
            const runner = new ActivityRunner(
                this.logger, dashService, requestToken ?? '',
                cookies, fingerprint, this.config.getConfig().speedSettings
            )

            // Search Streak first (3 Bing searches)
            await runner.doSearchStreak(page)

            const dailySetCount = await runner.doDailySet(dashboardData, page)

            // Refresh dashboard data after Daily Set so Keep Earning sees latest state
            this.logger.info(wId, '[DESKTOP] Refreshing dashboard data for Keep Earning...')
            const freshData = await dashService.getDashboardData(cookies, fingerprint, page).catch(() => dashboardData)
            const morePromoCount = await runner.doMorePromotions(freshData, page)

            // Check final points
            const finalPoints = await dashService.getCurrentPoints(cookies, fingerprint).catch(() => currentPoints)
            const earned = finalPoints - currentPoints

            this.logger.info(wId, `[DESKTOP] Complete | dailySet=${dailySetCount} | morePromotions=${morePromoCount} | +${earned} pts | balance=${finalPoints}`)

            // Wait before closing
            await new Promise(r => setTimeout(r, 5000))

        } catch (error) {
            this.logger.error(wId, `[DESKTOP] Failed for ${account.email}`, { error: error instanceof Error ? error.message : String(error) })
            throw error
        } finally {
            await browserManager.closeContext(session.context)
        }
    }

    /**
     * Execute mobile automation flow (Keep Earning)
     */
    private async executeMobileFlow(
        account: Account,
        browserManager: any,
        sessionManager: any,
        loginManager: any,
        wId: string
    ): Promise<void> {
        this.logger.info(wId, `[MOBILE] Starting mobile flow for ${account.email}`)

        // Launch mobile browser
        await browserManager.launchBrowser(this.config.isHeadless(), true)

        // Create mobile browser context
        const session = await browserManager.createContext(account, true)

        try {
            // Create page
            const page = await browserManager.createPage(session.context)

            // Try to restore session first
            const hasSession = await sessionManager.restoreSession(account, session.context, true)

            if (hasSession) {
                this.logger.info(wId, '[MOBILE] Session found, verifying login status...')
                await browserManager.goto(page, 'https://rewards.bing.com/')
                const isLoggedIn = await loginManager.isLoggedIn(page)

                if (!isLoggedIn) {
                    this.logger.warn(wId, '[MOBILE] Session expired, performing fresh login')
                    await loginManager.login(page, account)
                } else {
                    this.logger.info(wId, '[MOBILE] Session valid, skipping login')
                }
            } else {
                this.logger.info(wId, '[MOBILE] No session found, performing login')
                await loginManager.login(page, account)
            }

            // Save session after successful login/verification
            await sessionManager.saveSession(account, session.context, true)

            // --- API-Based Mobile Flow ---

            // Get cookies and fingerprint for API calls
            const cookies = await session.context.cookies()
            const fingerprint = session.fingerprint

            // Initialize dashboard service and get token
            const dashService = new DashboardService(this.logger)
            const requestToken = await dashService.getRequestToken(page)

            if (!requestToken) {
                this.logger.warn(wId, '[MOBILE] RequestVerificationToken not found, API activities may fail')
            }

            // Fetch dashboard data via API (using mobile cookies)
            this.logger.info(wId, '[MOBILE] Fetching dashboard data...')
            const dashboardData = await dashService.getDashboardData(cookies, fingerprint, page)

            const currentPoints = dashboardData.userStatus.availablePoints
            this.logger.info(wId, `[MOBILE] Current points: ${currentPoints}`)

            // Run activities via API
            const runner = new ActivityRunner(
                this.logger, dashService, requestToken ?? '',
                cookies, fingerprint, this.config.getConfig().speedSettings
            )

            // Search Streak first (3 Bing searches)
            await runner.doSearchStreak(page)

            const dailySetCount = await runner.doDailySet(dashboardData, page)

            // Refresh dashboard data after Daily Set so Keep Earning sees latest state
            this.logger.info(wId, '[MOBILE] Refreshing dashboard data for Keep Earning...')
            const freshData = await dashService.getDashboardData(cookies, fingerprint, page).catch(() => dashboardData)
            const morePromoCount = await runner.doMorePromotions(freshData, page)

            // Check final points
            const finalPoints = await dashService.getCurrentPoints(cookies, fingerprint).catch(() => currentPoints)
            const earned = finalPoints - currentPoints

            this.logger.info(wId, `[MOBILE] Complete | dailySet=${dailySetCount} | morePromotions=${morePromoCount} | +${earned} pts | balance=${finalPoints}`)

            // Wait before closing
            await new Promise(r => setTimeout(r, 3000))

        } catch (error) {
            this.logger.error(wId, `[MOBILE] Failed for ${account.email}`, { error: error instanceof Error ? error.message : String(error) })
            throw error
        } finally {
            await browserManager.closeContext(session.context)
        }
    }

    /**
     * Log execution summary
     */
    private logSummary(stats: AccountStats[]): void {
        const successful = stats.filter(s => s.success).length
        const failed = stats.filter(s => !s.success).length
        const totalPoints = stats.reduce((sum, s) => sum + s.collectedPoints, 0)

        this.logger.info('SUMMARY', '='.repeat(50))
        this.logger.info('SUMMARY', `Total Accounts: ${stats.length}`)
        this.logger.info('SUMMARY', `Successful: ${successful}`)
        this.logger.info('SUMMARY', `Failed: ${failed}`)
        this.logger.info('SUMMARY', `Total Points Earned: ${totalPoints}`)
        this.logger.info('SUMMARY', '='.repeat(50))
    }
}

/**
 * Main function
 */
async function main(): Promise<void> {
    const bot = new MicrosoftRewardsBot()

    try {
        await bot.initialize()
        await bot.run()
    } catch (error) {
        bot.logger.critical('MAIN', 'Fatal error', { error: error instanceof Error ? error.message : String(error) })
        process.exit(1)
    }
}

// Run bot when executed directly
if (require.main === module) {
    main().catch(error => {
        console.error('Unhandled error:', error)
        process.exit(1)
    })
}

export { executionContext, MicrosoftRewardsBot }
