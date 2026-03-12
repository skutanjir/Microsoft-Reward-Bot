/**
 * Main Entry Point
 * Execution engine orchestrator for Microsoft Rewards Automation Platform
 *
 * EXECUTION ORDER PER ACCOUNT:
 *  Desktop flow:
 *    1. Your Activity check  (baseline points snapshot)
 *    2. Search Streak        (3 Bing searches)
 *    3. Daily Set            (today's daily activities)
 *    4. More Promotions      (Keep Earning / earn page)
 *    5. Point Verification   (confirm points registered)
 *
 *  Mobile flow (same order):
 *    1. Your Activity check
 *    2. Search Streak
 *    3. Daily Set
 *    4. More Promotions
 *    5. Mobile Check-in
 *    6. Point Verification
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'path'

import dotenv from 'dotenv'
dotenv.config()

import { ConfigManager } from './config/ConfigManager'
import { Logger } from './logging/Logger'
import { Utils } from './util/Utils'
import { AiService } from './services/AiService'
import { UIService } from './services/UIService'

import type { ExecutionContext, Account, AccountStats } from './types'
import { DashboardService } from './services/DashboardService'
import { ActivityRunner } from './services/ActivityRunner'

// Async local storage for execution context
const executionContext = new AsyncLocalStorage<ExecutionContext>()

export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) throw new Error('No execution context available')
    return context
}

// ══════════════════════════════════════════════════════════════════════════════
// BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class MicrosoftRewardsBot {
    public logger: Logger
    public config: ConfigManager
    public utils: Utils

    private _selectorBank!: any
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

    async initialize(): Promise<void> {
        this.logger.info('BOT', 'Initializing bot dependencies...')

        const { BrowserManager } = await import('./browser/BrowserManager')
        const { SessionManager } = await import('./browser/SessionManager')
        const { LoginManager } = await import('./browser/LoginManager')

        this.BrowserManagerClass = BrowserManager
        this.SessionManagerClass = SessionManager
        this.LoginManagerClass = LoginManager

        const { SelectorPersistence } = await import('./selectors/SelectorPersistence')
        const { SelectorBank } = await import('./selectors/SelectorBank')
        const { SelectorSeeder } = await import('./selectors/SelectorSeeder')

        const dbPath = path.join(process.cwd(), 'selectors.sqlite')
        const persistence = new SelectorPersistence(this.logger, dbPath)
        this._selectorBank = new SelectorBank(this.logger, persistence)

        SelectorSeeder.seed(this._selectorBank)

        this.logger.info('BOT', 'Bot initialization complete')
    }

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
        this.logger.info('BOT', `EXECUTION COMPLETE — Duration: ${this.utils.formatDuration(duration)}`)
        this.logger.info('BOT', '='.repeat(80))
    }

    private async runWithWorkers(accounts: Account[], workerCount: number): Promise<AccountStats[]> {
        const allStats: AccountStats[] = []

        for (let batchStart = 0; batchStart < accounts.length; batchStart += workerCount) {
            const batch = accounts.slice(batchStart, batchStart + workerCount)
            const batchNum = Math.floor(batchStart / workerCount) + 1
            const totalBatches = Math.ceil(accounts.length / workerCount)

            this.logger.info('BOT', `--- Batch ${batchNum}/${totalBatches} (${batch.length} worker(s)) ---`)

            const results = await Promise.allSettled(
                batch.map((account, idx) => this.processAccount(account, batchStart + idx))
            )

            for (let i = 0; i < results.length; i++) {
                const result = results[i]
                if (result.status === 'fulfilled') {
                    allStats.push(result.value)
                } else {
                    allStats.push({
                        email: batch[i].email,
                        initialPoints: 0, finalPoints: 0, collectedPoints: 0,
                        duration: 0, success: false, tasksCompleted: 0, tasksFailed: 0,
                        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
                    })
                }
            }
        }

        return allStats
    }

    private async processAccount(account: Account, workerIdx: number): Promise<AccountStats> {
        const wId = `W${workerIdx}`
        this.logger.info(wId, `Starting worker for: ${account.email}`)

        const accountStats: AccountStats = {
            email: account.email,
            initialPoints: 0, finalPoints: 0, collectedPoints: 0,
            duration: 0, success: false, tasksCompleted: 0, tasksFailed: 0
        }

        const startTime = Date.now()

        const aiService = new AiService(this.logger)
        const uiService = new UIService(this.logger, aiService)
        const browserManager = new this.BrowserManagerClass(this.logger, this.utils)
        const sessionManager = new this.SessionManagerClass(this.logger, this.config.getConfig().sessionPath)
        const loginManager = new this.LoginManagerClass(this.logger, this.utils)
        const visualHandler = new (require('./services/activities/VisualActivityHandler').VisualActivityHandler)(this.logger, aiService)

        try {
            const desktopContext: ExecutionContext = {
                account, isMobile: false, sessionStart: new Date(), initialPoints: 0, currentPoints: 0
            }
            await executionContext.run(desktopContext, async () => {
                await this.executeDesktopFlow(account, browserManager, sessionManager, loginManager, visualHandler, uiService, wId)
            })

            const mobileContext: ExecutionContext = {
                account, isMobile: true, sessionStart: new Date(), initialPoints: 0, currentPoints: 0
            }
            await executionContext.run(mobileContext, async () => {
                await this.executeMobileFlow(account, browserManager, sessionManager, loginManager, visualHandler, uiService, wId)
            })

            accountStats.success = true
            accountStats.duration = Date.now() - startTime
            this.logger.info(wId, `Completed: ${account.email} — Duration: ${this.utils.formatDuration(accountStats.duration)}`)
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

    // ══════════════════════════════════════════════════════════════════════════
    // DESKTOP FLOW
    //   1. Your Activity (baseline check)
    //   2. Search Streak
    //   3. Daily Set
    //   4. More Promotions
    //   5. Point Verification
    // ══════════════════════════════════════════════════════════════════════════

    private async executeDesktopFlow(
        account: Account,
        browserManager: any,
        sessionManager: any,
        loginManager: any,
        visualHandler: any,
        uiService: UIService,
        wId: string
    ): Promise<void> {
        this.logger.info(wId, `[DESKTOP] Starting desktop flow for ${account.email}`)

        await browserManager.launchBrowser(this.config.isHeadless(), false)
        const session = await browserManager.createContext(account, false)

        try {
            const page = await browserManager.createPage(session.context)

            // ── Login / session restore ──────────────────────────────────────
            const hasSession = await sessionManager.restoreSession(account, session.context, false)
            if (hasSession) {
                this.logger.info(wId, '[DESKTOP] Session found, verifying login status...')
                await browserManager.goto(page, 'https://rewards.bing.com/')
                if (!await loginManager.isLoggedIn(page)) {
                    this.logger.warn(wId, '[DESKTOP] Session expired, performing fresh login')
                    await loginManager.login(page, account)
                } else {
                    this.logger.info(wId, '[DESKTOP] Session valid, skipping login')
                }
            } else {
                this.logger.info(wId, '[DESKTOP] No session found, performing login')
                await loginManager.login(page, account)
            }
            await sessionManager.saveSession(account, session.context, false)

            // ── API setup ────────────────────────────────────────────────────
            const cookies = await session.context.cookies()
            const fingerprint = session.fingerprint
            const dashService = new DashboardService(this.logger, uiService)
            const requestToken = await dashService.getRequestToken(page)

            if (!requestToken) {
                this.logger.warn(wId, '[DESKTOP] RequestVerificationToken not found, API activities may fail')
            }

            const runner = new ActivityRunner(
                this.logger, dashService, requestToken ?? '',
                cookies, fingerprint, this.config.getConfig().speedSettings, visualHandler
            )

            // ━━━ STEP 1: Your Activity (baseline) ━━━━━━━━━━━━━━━━━━━━━━━━━━
            const initialPoints = await runner.doActivityCheck(page)
            this.logger.info(wId, `[DESKTOP] Baseline points: ${initialPoints}`)

            // ━━━ STEP 2: Search Streak ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            await runner.doSearchStreak(page)

            // Fetch dashboard data AFTER search streak so it's fresh
            this.logger.info(wId, '[DESKTOP] Fetching dashboard data...')
            const dashboardData = await dashService.getDashboardData(cookies, fingerprint, page)
            this.logger.info(wId, `[DESKTOP] Current points (post-search): ${dashboardData.userStatus.availablePoints}`)

            // ━━━ STEP 3: Daily Set ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            const dailySetCount = await runner.doDailySet(dashboardData, page)

            // Refresh dashboard data so More Promotions sees up-to-date state
            this.logger.info(wId, '[DESKTOP] Refreshing dashboard data for More Promotions...')
            const freshData = await dashService.getDashboardData(cookies, fingerprint, page).catch(() => dashboardData)

            // ━━━ STEP 4: More Promotions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            const morePromoCount = await runner.doMorePromotions(freshData, page)

            // ━━━ STEP 5: Point Verification ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            await runner.doPointVerification(page)

            const finalPoints = await dashService.getCurrentPoints(cookies, fingerprint).catch(() => dashboardData.userStatus.availablePoints)
            const earned = finalPoints - initialPoints

            this.logger.info(wId, `[DESKTOP] Complete | dailySet=${dailySetCount} | morePromotions=${morePromoCount} | +${earned} pts | balance=${finalPoints}`)

            await new Promise(r => setTimeout(r, 5000))
        } catch (error) {
            this.logger.error(wId, `[DESKTOP] Failed for ${account.email}`, {
                error: error instanceof Error ? error.message : String(error)
            })
            throw error
        } finally {
            await browserManager.closeContext(session.context)
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MOBILE FLOW
    //   1. Your Activity (baseline check)
    //   2. Search Streak
    //   3. Daily Set
    //   4. More Promotions
    //   5. Mobile Check-in
    //   6. Point Verification
    // ══════════════════════════════════════════════════════════════════════════

    private async executeMobileFlow(
        account: Account,
        browserManager: any,
        sessionManager: any,
        loginManager: any,
        visualHandler: any,
        uiService: UIService,
        wId: string
    ): Promise<void> {
        this.logger.info(wId, `[MOBILE] Starting mobile flow for ${account.email}`)

        await browserManager.launchBrowser(this.config.isHeadless(), true)
        const session = await browserManager.createContext(account, true)

        try {
            const page = await browserManager.createPage(session.context)

            // ── Login / session restore ──────────────────────────────────────
            const hasSession = await sessionManager.restoreSession(account, session.context, true)
            if (hasSession) {
                this.logger.info(wId, '[MOBILE] Session found, verifying login status...')
                await browserManager.goto(page, 'https://rewards.bing.com/')
                if (!await loginManager.isLoggedIn(page)) {
                    this.logger.warn(wId, '[MOBILE] Session expired, performing fresh login')
                    await loginManager.login(page, account)
                } else {
                    this.logger.info(wId, '[MOBILE] Session valid, skipping login')
                }
            } else {
                this.logger.info(wId, '[MOBILE] No session found, performing login')
                await loginManager.login(page, account)
            }
            await sessionManager.saveSession(account, session.context, true)

            // ── API setup ────────────────────────────────────────────────────
            const cookies = await session.context.cookies()
            const fingerprint = session.fingerprint
            const dashService = new DashboardService(this.logger, uiService)
            const requestToken = await dashService.getRequestToken(page)

            if (!requestToken) {
                this.logger.warn(wId, '[MOBILE] RequestVerificationToken not found, API activities may fail')
            }

            const runner = new ActivityRunner(
                this.logger, dashService, requestToken ?? '',
                cookies, fingerprint, this.config.getConfig().speedSettings, visualHandler
            )

            // ━━━ STEP 1: Your Activity (baseline) ━━━━━━━━━━━━━━━━━━━━━━━━━━
            const initialPoints = await runner.doActivityCheck(page)
            this.logger.info(wId, `[MOBILE] Baseline points: ${initialPoints}`)

            // ━━━ STEP 2: Search Streak ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            await runner.doSearchStreak(page)

            // Fetch dashboard data fresh after searches
            this.logger.info(wId, '[MOBILE] Fetching dashboard data...')
            const dashboardData = await dashService.getDashboardData(cookies, fingerprint, page)
            this.logger.info(wId, `[MOBILE] Current points (post-search): ${dashboardData.userStatus.availablePoints}`)

            // ━━━ STEP 3: Daily Set ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            const dailySetCount = await runner.doDailySet(dashboardData, page)

            // Refresh
            this.logger.info(wId, '[MOBILE] Refreshing dashboard data for More Promotions...')
            const freshData = await dashService.getDashboardData(cookies, fingerprint, page).catch(() => dashboardData)

            // ━━━ STEP 4: More Promotions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            const morePromoCount = await runner.doMorePromotions(freshData, page)

            // ━━━ STEP 5: Mobile Check-in ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            await runner.doMobileCheckIn(page)

            // ━━━ STEP 6: Point Verification ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            await runner.doPointVerification(page)

            const finalPoints = await dashService.getCurrentPoints(cookies, fingerprint).catch(() => dashboardData.userStatus.availablePoints)
            const earned = finalPoints - initialPoints

            this.logger.info(wId, `[MOBILE] Complete | dailySet=${dailySetCount} | morePromotions=${morePromoCount} | +${earned} pts | balance=${finalPoints}`)

            await new Promise(r => setTimeout(r, 3000))
        } catch (error) {
            this.logger.error(wId, `[MOBILE] Failed for ${account.email}`, {
                error: error instanceof Error ? error.message : String(error)
            })
            throw error
        } finally {
            await browserManager.closeContext(session.context)
        }
    }

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

// ══════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    const bot = new MicrosoftRewardsBot()
    try {
        await bot.initialize()
        await bot.run()
    } catch (error) {
        bot.logger.critical('MAIN', 'Fatal error', {
            error: error instanceof Error ? error.message : String(error)
        })
        process.exit(1)
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('Unhandled error:', error)
        process.exit(1)
    })
}

export { executionContext, MicrosoftRewardsBot }