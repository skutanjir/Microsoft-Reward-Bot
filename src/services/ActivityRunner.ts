import type { Cookie, Page } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import type { BasePromotion, DashboardData } from '../types'
import { DashboardService } from './DashboardService'
import { ApiUrlReward } from './activities/ApiUrlReward'
import { ApiQuiz } from './activities/ApiQuiz'
import { ApiSearchOnBing } from './activities/ApiSearchOnBing'
import { VisualActivityHandler } from './activities/VisualActivityHandler'
import { Logger } from '../logging/Logger'

export class ActivityRunner {
    private logger: Logger
    private dashboardService: DashboardService
    private requestToken: string
    private cookies: Cookie[]
    private fingerprint: BrowserFingerprintWithHeaders
    private visualHandler: VisualActivityHandler
    private minDelay: number
    private maxDelay: number

    constructor(
        logger: Logger,
        dashboardService: DashboardService,
        requestToken: string,
        cookies: Cookie[],
        fingerprint: BrowserFingerprintWithHeaders,
        speedSettings?: { minDelay: number; maxDelay: number },
        visualHandler?: VisualActivityHandler
    ) {
        this.logger = logger
        this.dashboardService = dashboardService
        this.requestToken = requestToken
        this.cookies = cookies
        this.fingerprint = fingerprint
        this.visualHandler = visualHandler || new VisualActivityHandler(logger)
        this.minDelay = speedSettings?.minDelay ?? 5000
        this.maxDelay = speedSettings?.maxDelay ?? 15000
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 1 — CHECK YOUR ACTIVITY (Point history verification)
    // This is the FIRST thing we do so we know the baseline state.
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Navigate to the "Your Activity" page and snapshot current point balance.
     * Must be called FIRST before any earning actions.
     */
    async doActivityCheck(page: Page): Promise<number> {
        this.logger.info('ACTIVITY-CHECK', '━━━ STEP 1: Checking Your Activity (baseline points) ━━━')

        try {
            await this.dashboardService.navigateToActivity(page)
            await page.waitForTimeout(3000)

            // Try to read visible point balance from the activity page
            const points = await page.evaluate(() => {
                const selectors = [
                    '.totalPoints',
                    '.points-breakdown',
                    '[class*="points"]',
                    '[data-testid="points"]'
                ]
                for (const sel of selectors) {
                    const el = document.querySelector(sel) as HTMLElement | null
                    if (el?.innerText) return el.innerText.trim()
                }
                return null
            }).catch(() => null)

            if (points) {
                this.logger.info('ACTIVITY-CHECK', `Your Activity page loaded. Visible balance: ${points}`)
            } else {
                this.logger.info('ACTIVITY-CHECK', 'Your Activity page loaded (balance element not visible in DOM — normal)')
            }

            // Also pull balance from API for a reliable number
            const apiPoints = await this.dashboardService
                .getCurrentPoints(this.cookies, this.fingerprint)
                .catch(() => 0)

            this.logger.info('ACTIVITY-CHECK', `API baseline points: ${apiPoints}`)

            // Navigate back to the dashboard so subsequent steps start from a known URL
            await page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { })

            return apiPoints
        } catch (error) {
            this.logger.warn(
                'ACTIVITY-CHECK',
                `Could not complete activity check: ${error instanceof Error ? error.message : String(error)}`
            )
            await page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { })
            return 0
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 2 — SEARCH STREAK (3 Bing searches)
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Execute Search Streak — perform 3 random Bing searches.
     * This satisfies the "Bing Search Streak" reward on the dashboard.
     */
    async doSearchStreak(page: Page): Promise<void> {
        this.logger.info('SEARCH-STREAK', '━━━ STEP 2: Bing Search Streak (3 searches) ━━━')

        const topics = [
            'latest world news today', 'weather forecast this week', 'best recipes for dinner',
            'top movies 2025', 'how to learn programming', 'health tips for winter',
            'travel destinations 2025', 'technology trends', 'science discoveries',
            'sports highlights today', 'music new releases', 'book recommendations',
            'home improvement ideas', 'fitness workout plan', 'cooking tips and tricks'
        ]

        const shuffled = topics.sort(() => Math.random() - 0.5)
        const queries = shuffled.slice(0, 3)

        for (let i = 0; i < queries.length; i++) {
            const query = queries[i]
            try {
                this.logger.info('SEARCH-STREAK', `Search ${i + 1}/3: "${query}"`)

                await page.goto('https://www.bing.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { })
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { })

                const searchBox = page.locator('#sb_form_q')
                await searchBox.waitFor({ state: 'attached', timeout: 10000 })

                await this.wait(300, 600)
                await searchBox.click({ clickCount: 3 }).catch(() => { })
                await searchBox.fill('')
                await page.keyboard.type(query, { delay: 50 + Math.floor(Math.random() * 50) })
                await page.keyboard.press('Enter')

                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { })

                const delay = 5000 + Math.floor(Math.random() * 5000)
                this.logger.debug('SEARCH-STREAK', `Waiting ${(delay / 1000).toFixed(1)}s...`)
                await this.wait(delay, delay)
            } catch (error) {
                this.logger.warn('SEARCH-STREAK', `Search ${i + 1} failed: ${error instanceof Error ? error.message : String(error)}`)
            }
        }

        this.logger.info('SEARCH-STREAK', 'Search Streak complete (3/3)')

        // Navigate back to rewards dashboard
        await page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { })
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 3 — DAILY SET
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Process today's Daily Set promotions.
     */
    async doDailySet(data: DashboardData, page: Page): Promise<number> {
        this.logger.info('DAILY-SET', '━━━ STEP 3: Daily Set ━━━')

        // Navigate to rewards homepage where Daily Set cards live
        await page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { })
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { })
        await page.waitForTimeout(1500)

        // Expand UI sections
        await this.dashboardService.expandDashboardSections(page, data)

        const todayKey = this.dashboardService.getFormattedDate()
        const keys = Object.keys(data.dailySetPromotions || {})

        this.logger.debug('DAILY-SET', `Available Daily Set keys: ${keys.join(', ')} (Target: ${todayKey})`)

        if (keys.length === 0) {
            this.logger.warn('DAILY-SET', 'No Daily Set promotions found in dashboard data')
            return 0
        }

        let targetKey = todayKey
        let promotions = data.dailySetPromotions[targetKey]

        if (!promotions) {
            // Timezone fallback: use most recent past key
            const sortedKeys = keys.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())
            const todayDate = new Date(todayKey).getTime()
            const fallback = sortedKeys.find(k => new Date(k).getTime() <= todayDate)

            if (fallback) {
                this.logger.info('DAILY-SET', `Today's key "${todayKey}" not found, using fallback: "${fallback}"`)
                targetKey = fallback
                promotions = data.dailySetPromotions[targetKey]
            } else {
                this.logger.info('DAILY-SET', `No matching date key found for today (${todayKey}). Available: ${keys.join(', ')}`)
                return 0
            }
        }

        promotions!.forEach(p => {
            this.logger.debug('DAILY-SET', `  - ${p.title} (type=${p.promotionType}, complete=${p.complete}, max=${p.pointProgressMax})`)
        })

        const uncompleted = promotions!.filter(x => !x.complete && x.pointProgressMax > 0)

        if (!uncompleted.length) {
            this.logger.info('DAILY-SET', `All Daily Set items for ${targetKey} already completed`)
            return 0
        }

        this.logger.info('DAILY-SET', `Solving ${uncompleted.length} Daily Set item(s)`)
        await this.solveActivities(uncompleted, page)
        this.logger.info('DAILY-SET', 'Daily Set complete')

        return uncompleted.length
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 4 — MORE PROMOTIONS (Keep Earning)
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Process More Promotions / Keep Earning promotions.
     */
    async doMorePromotions(data: DashboardData, page: Page): Promise<number> {
        this.logger.info('MORE-PROMOTIONS', '━━━ STEP 4: More Promotions / Keep Earning ━━━')

        await page.goto('https://rewards.bing.com/earn', { waitUntil: 'networkidle' }).catch(() => { })
        await page.waitForTimeout(1000)

        // Expand sections on the earn page
        await this.dashboardService.expandDashboardSections(page, data)

        // Deduplicate by offerId
        const morePromotions: BasePromotion[] = [
            ...new Map(
                [
                    ...(data.morePromotions ?? []),
                    ...(data.morePromotionsWithoutPromotionalItems ?? []),
                    ...(data.promotionalItems ?? [])
                ]
                    .filter(Boolean)
                    .map(p => [p.offerId || `missing_${Math.random()}`, p as BasePromotion] as const)
            ).values()
        ]

        const uncompleted = morePromotions.filter(x => {
            if (x.complete) return false
            if (x.pointProgressMax <= 0) return false
            if (x.exclusiveLockedFeatureStatus === 'locked') return false
            return true
        })

        if (!uncompleted.length) {
            this.logger.info('MORE-PROMOTIONS', 'All More Promotions already completed')
            return 0
        }

        this.logger.info('MORE-PROMOTIONS', `Solving ${uncompleted.length} More Promotion item(s)`)
        await this.solveActivities(uncompleted, page)
        this.logger.info('MORE-PROMOTIONS', 'More Promotions complete')

        return uncompleted.length
    }

    // ══════════════════════════════════════════════════════════════════════════
    // POINT VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Navigate to the activity history page to confirm points registered.
     * Call LAST after all earning activities.
     */
    async doPointVerification(page: Page): Promise<void> {
        this.logger.info('ACTIVITY-VERIFY', '━━━ FINAL: Point Verification ━━━')
        await this.dashboardService.navigateToActivity(page)
        await page.waitForTimeout(2000)

        const points = await page.evaluate(() => {
            const el = document.querySelector('.totalPoints, .points-breakdown') as HTMLElement | null
            return el ? el.innerText : 'Hidden'
        }).catch(() => 'Error')

        this.logger.info('ACTIVITY-VERIFY', `Verification complete. Visible status: ${points}`)
        await page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded' }).catch(() => { })
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MOBILE CHECK-IN
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Handle the mobile-specific daily check-in.
     */
    async doMobileCheckIn(page: Page): Promise<void> {
        this.logger.info('MOBILE-CHECKIN', 'Attempting daily mobile check-in...')
        await this.dashboardService.navigateToCheckIn(page)
        await page.waitForTimeout(3000)

        const clicked = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
                .find(b => {
                    const t = ((b as HTMLElement).innerText || '').toLowerCase()
                    return t.includes('check') || t.includes('claim') || t.includes('tap')
                })
            if (btn) {
                (btn as HTMLElement).click()
                return true
            }
            return false
        }).catch(() => false)

        if (clicked) {
            this.logger.info('MOBILE-CHECKIN', 'Check-in button clicked successfully')
            await page.waitForTimeout(2000)
        } else {
            this.logger.debug('MOBILE-CHECKIN', 'No explicit check-in button found (may be automatic or already claimed)')
        }

        await page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded' }).catch(() => { })
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL — ACTIVITY DISPATCHER
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Dispatch activities to the appropriate handler based on promotionType.
     */
    private async solveActivities(activities: BasePromotion[], page: Page): Promise<void> {
        // Refresh token if missing
        if (!this.requestToken) {
            this.logger.info('ACTIVITY', 'Request token missing, attempting to refresh...')
            const newToken = await this.dashboardService.getRequestToken(page)
            if (newToken) {
                this.requestToken = newToken
                this.logger.info('ACTIVITY', 'Request token refreshed successfully')
            } else {
                this.logger.warn('ACTIVITY', 'Failed to refresh request token, API activities may fail')
            }
        }

        const homepageUrl = 'https://rewards.bing.com/'

        for (const activity of activities) {
            try {
                const type = activity.promotionType?.toLowerCase() ?? ''
                const name = activity.name?.toLowerCase() ?? ''
                const offerId = activity.offerId

                // Always navigate back to homepage before each activity
                // to ensure .pointLink selectors are available
                try {
                    const pages = page.context().pages()
                    if (pages.length > 3) {
                        for (let i = pages.length - 1; i > 0; i--) {
                            await pages[i].close().catch(() => { })
                        }
                        page = pages[0]
                    }

                    const currentUrl = page.url()
                    if (!currentUrl.includes('rewards.bing.com')) {
                        this.logger.debug('ACTIVITY', 'Navigating back to rewards homepage...')
                        await page.goto(homepageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
                        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { })
                    }

                    await this.dashboardService.expandDashboardSections(page)
                } catch {
                    this.logger.debug('ACTIVITY', 'Could not navigate back to homepage, continuing...')
                }

                this.logger.debug(
                    'ACTIVITY',
                    `Processing | title="${activity.title}" | offerId=${offerId} | type=${type}`
                )

                switch (type) {
                    case 'quiz': {
                        // Poll detection: 10 pts + pollscenarioid in URL
                        if (
                            activity.pointProgressMax === 10 &&
                            activity.destinationUrl?.toLowerCase().includes('pollscenarioid')
                        ) {
                            this.logger.info('ACTIVITY', `Poll detected | title="${activity.title}" | offerId=${offerId} → Visual Handler`)
                            await this.visualHandler.execute(page, offerId, activity.title)
                            break
                        }

                        this.logger.info('ACTIVITY', `Quiz | title="${activity.title}" | offerId=${offerId}`)
                        const quiz = new ApiQuiz(this.logger, this.dashboardService, this.cookies, this.fingerprint)
                        await quiz.execute(activity)
                        break
                    }

                    case 'urlreward': {
                        if (
                            name.includes('exploreonbing') ||
                            (activity.destinationUrl?.toLowerCase().includes('bing.com/search') &&
                                !activity.destinationUrl?.toLowerCase().includes('quiz'))
                        ) {
                            if (!this.requestToken) {
                                this.logger.warn('ACTIVITY', `Token missing for SearchOnBing "${activity.title}" → Visual fallback`)
                                await this.visualHandler.execute(page, offerId, activity.title)
                                break
                            }
                            this.logger.info('ACTIVITY', `SearchOnBing | title="${activity.title}" | offerId=${offerId}`)
                            const search = new ApiSearchOnBing(
                                this.logger, this.dashboardService, this.requestToken,
                                this.cookies, this.fingerprint,
                                { minDelay: this.minDelay, maxDelay: this.maxDelay }
                            )
                            await search.execute(activity, page)
                        } else {
                            if (!this.requestToken) {
                                this.logger.warn('ACTIVITY', `Token missing for UrlReward "${activity.title}" → Visual fallback`)
                                await this.visualHandler.execute(page, offerId, activity.title)
                                break
                            }
                            this.logger.info('ACTIVITY', `UrlReward | title="${activity.title}" | offerId=${offerId}`)
                            const urlReward = new ApiUrlReward(
                                this.logger, this.dashboardService, this.requestToken,
                                this.cookies, this.fingerprint
                            )
                            await urlReward.execute(activity)
                        }
                        break
                    }

                    case 'findclippy': {
                        this.logger.info('ACTIVITY', `FindClippy | title="${activity.title}" | offerId=${offerId}`)
                        const clippy = new ApiUrlReward(
                            this.logger, this.dashboardService, this.requestToken,
                            this.cookies, this.fingerprint
                        )
                        await clippy.execute(activity)
                        break
                    }

                    default: {
                        if (activity.pointProgressMax > 0) {
                            this.logger.info(
                                'ACTIVITY',
                                `Unknown type "${activity.promotionType}" | title="${activity.title}" | offerId=${offerId} → Visual Handler`
                            )
                            await this.visualHandler.execute(page, offerId, activity.title)
                        } else {
                            this.logger.debug(
                                'ACTIVITY',
                                `Skipping "${activity.title}" | offerId=${offerId} | no points`
                            )
                        }
                        break
                    }
                }

                // Cooldown between activities
                const delay = this.minDelay + Math.floor(Math.random() * (this.maxDelay - this.minDelay))
                this.logger.debug('ACTIVITY', `Cooldown ${(delay / 1000).toFixed(1)}s before next activity...`)
                await this.wait(delay, delay)
            } catch (error) {
                this.logger.error(
                    'ACTIVITY',
                    `Error solving "${activity.title}" | ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // UTILS
    // ══════════════════════════════════════════════════════════════════════════

    private wait(min: number, max: number): Promise<void> {
        const delay = min + Math.floor(Math.random() * (max - min))
        return new Promise(r => setTimeout(r, delay))
    }
}