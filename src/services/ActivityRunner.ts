
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

    /**
     * Process today's Daily Set promotions.
     */
    async doDailySet(data: DashboardData, page: Page): Promise<number> {
        this.logger.info('DAILY-SET', 'Checking Daily Set status...')

        // Navigate to rewards homepage (TheNetsky's .pointLink selectors work on the homepage)
        await page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { })
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { })
        await page.waitForTimeout(1500)

        // Expand UI sections (Daily Set, Keep Earning, etc.)
        await this.dashboardService.expandDashboardSections(page, data)

        const todayKey = this.dashboardService.getFormattedDate()

        // Log available keys for debugging
        const keys = Object.keys(data.dailySetPromotions || {})
        this.logger.debug('DAILY-SET', `Available Daily Set keys: ${keys.join(', ')} (Target: ${todayKey})`)

        if (keys.length === 0) {
            this.logger.warn('DAILY-SET', 'No Daily Set promotions found in dashboard data')
            return 0
        }

        // Only process TODAY's date key — do NOT iterate all keys.
        // This prevents processing tomorrow's items that don't exist on the page yet.
        let targetKey = todayKey
        let promotions = data.dailySetPromotions[targetKey]

        if (!promotions) {
            // Timezone fallback: if today's key is missing, use the most recent past key
            // Sort keys as dates descending, pick the first one that is <= today
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

        // Log all items for this date
        promotions!.forEach(p => {
            this.logger.debug('DAILY-SET', `  - ${p.title} (type=${p.promotionType}, complete=${p.complete}, max=${p.pointProgressMax})`)
        })

        // Filter to only uncompleted items with points
        const uncompleted = promotions!.filter(x => !x.complete && x.pointProgressMax > 0)

        if (!uncompleted.length) {
            this.logger.info('DAILY-SET', `All "Daily Set" items for ${targetKey} have already been completed`)
            return 0
        }

        this.logger.info('DAILY-SET', `Started solving ${uncompleted.length} "Daily Set" items`)
        await this.solveActivities(uncompleted, page)
        this.logger.info('DAILY-SET', 'All "Daily Set" items have been completed')

        return uncompleted.length
    }

    /**
     * Process More Promotions / Keep Earning promotions.
     */
    async doMorePromotions(data: DashboardData, page: Page): Promise<number> {
        // Navigate to /earn as requested
        this.logger.info('MORE-PROMOTIONS', 'Navigating to /earn page...')
        await page.goto('https://rewards.bing.com/earn', { waitUntil: 'networkidle' }).catch(() => { })
        await page.waitForTimeout(1000)

        // Expand sections on the earn page (where "Keep earning" lives)
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
            this.logger.info('MORE-PROMOTIONS', 'All "More Promotion" items have already been completed')
            return 0
        }

        this.logger.info('MORE-PROMOTIONS', `Started solving ${uncompleted.length} "More Promotions" items`)
        await this.solveActivities(uncompleted, page)
        this.logger.info('MORE-PROMOTIONS', 'All "More Promotion" items have been completed')

        return uncompleted.length
    }

    /**
     * Dispatch activities to the appropriate handler based on promotionType.
     */
    private async solveActivities(activities: BasePromotion[], page: Page): Promise<void> {
        // Try to refresh token if missing
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

                // TheNetsky pattern: Always navigate back to homepage before each activity
                // This ensures .pointLink selectors are available for clicking
                try {
                    const pages = page.context().pages()
                    if (pages.length > 3) {
                        // Close extra tabs to prevent tab proliferation
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

                    // Re-expand sections — they collapse on page navigation/React re-render
                    await this.dashboardService.expandDashboardSections(page)
                } catch {
                    this.logger.debug('ACTIVITY', 'Could not navigate back to homepage, continuing...')
                }

                this.logger.debug(
                    'ACTIVITY',
                    `Processing activity | title="${activity.title}" | offerId=${offerId} | type=${type}`
                )

                switch (type) {
                    case 'quiz': {
                        // Poll detection: 10 points + pollscenarioid in URL
                        if (activity.pointProgressMax === 10 && activity.destinationUrl?.toLowerCase().includes('pollscenarioid')) {
                            this.logger.info('ACTIVITY', `Found "Poll" | title="${activity.title}" | offerId=${offerId} - Swapping to Visual Handler`)
                            await this.visualHandler.execute(page, offerId, activity.title)
                            break
                        }

                        this.logger.info('ACTIVITY', `Found "Quiz" | title="${activity.title}" | offerId=${offerId}`)
                        const quiz = new ApiQuiz(this.logger, this.dashboardService, this.cookies, this.fingerprint)
                        await quiz.execute(activity)
                        break
                    }

                    case 'urlreward': {
                        // SearchOnBing is a subtype of urlreward
                        if (name.includes('exploreonbing') || (activity.destinationUrl?.toLowerCase().includes('bing.com/search') && !activity.destinationUrl?.toLowerCase().includes('quiz'))) {
                            if (!this.requestToken) {
                                this.logger.warn('ACTIVITY', `Token missing for "SearchOnBing" | title="${activity.title}" - trying Visual Handler fallback`)
                                await this.visualHandler.execute(page, offerId, activity.title)
                                break
                            }

                            this.logger.info('ACTIVITY', `Found "SearchOnBing" | title="${activity.title}" | offerId=${offerId}`)
                            const search = new ApiSearchOnBing(
                                this.logger, this.dashboardService, this.requestToken,
                                this.cookies, this.fingerprint,
                                { minDelay: this.minDelay, maxDelay: this.maxDelay }
                            )
                            await search.execute(activity, page)
                        } else {
                            if (!this.requestToken) {
                                this.logger.warn('ACTIVITY', `Token missing for "UrlReward" | title="${activity.title}" - trying Visual Handler fallback`)
                                await this.visualHandler.execute(page, offerId, activity.title)
                                break
                            }

                            this.logger.info('ACTIVITY', `Found "UrlReward" | title="${activity.title}" | offerId=${offerId}`)
                            const urlReward = new ApiUrlReward(
                                this.logger, this.dashboardService, this.requestToken,
                                this.cookies, this.fingerprint
                            )
                            await urlReward.execute(activity)
                        }
                        break
                    }

                    case 'findclippy': {
                        this.logger.info('ACTIVITY', `Found "FindClippy" | title="${activity.title}" | offerId=${offerId}`)
                        // FindClippy uses the same reportactivity endpoint as UrlReward
                        const clippy = new ApiUrlReward(
                            this.logger, this.dashboardService, this.requestToken,
                            this.cookies, this.fingerprint
                        )
                        await clippy.execute(activity)
                        break
                    }

                    default: {
                        // Visual handler fallback for unknown/unsupported types (only if has points)
                        if (activity.pointProgressMax > 0) {
                            this.logger.info(
                                'ACTIVITY',
                                `Unknown type "${activity.promotionType}" for "${activity.title}" | offerId=${offerId} — trying Visual Handler`
                            )
                            await this.visualHandler.execute(page, offerId, activity.title)
                        } else {
                            this.logger.debug(
                                'ACTIVITY',
                                `Skipping "${activity.title}" | offerId=${offerId} | type="${activity.promotionType}" | no points`
                            )
                        }
                        break
                    }
                }

                // Cooldown between activities using configurable random delay (default 5-15s)
                const delay = this.minDelay + Math.floor(Math.random() * (this.maxDelay - this.minDelay))
                this.logger.debug('ACTIVITY', `Waiting ${(delay / 1000).toFixed(1)}s before next activity...`)
                await this.wait(delay, delay)
            } catch (error) {
                this.logger.error(
                    'ACTIVITY',
                    `Error solving activity "${activity.title}" | ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    /**
     * Execute Search Streak — perform 3 random Bing searches.
     * This satisfies the "Bing Search Streak" reward on the dashboard.
     */
    async doSearchStreak(page: Page): Promise<void> {
        this.logger.info('SEARCH-STREAK', 'Starting Bing Search Streak (3 searches)...')

        const topics = [
            'latest world news today', 'weather forecast this week', 'best recipes for dinner',
            'top movies 2025', 'how to learn programming', 'health tips for winter',
            'travel destinations 2025', 'technology trends', 'science discoveries',
            'sports highlights today', 'music new releases', 'book recommendations',
            'home improvement ideas', 'fitness workout plan', 'cooking tips and tricks'
        ]

        // Shuffle and pick 3
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

                // Wait for search results to load
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { })

                // Random delay 5-10s between searches
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

    /**
     * Verify points by navigating to the activity history page.
     * This ensures the bot "checks" its work and registers points more reliably.
     */
    async doPointVerification(page: Page): Promise<void> {
        this.logger.info('ACTIVITY-VERIFY', 'Starting point verification (Your Activity)...')
        await this.dashboardService.navigateToActivity(page)
        await page.waitForTimeout(2000)

        const points = await page.evaluate(() => {
            const el = document.querySelector('.totalPoints, .points-breakdown')
            return el ? (el as HTMLElement).innerText : 'Hidden'
        }).catch(() => 'Error')

        this.logger.info('ACTIVITY-VERIFY', `Verification complete. Visible status: ${points}`)
        await page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded' }).catch(() => { })
    }

    /**
     * Handle the mobile-specific daily check-in.
     */
    async doMobileCheckIn(page: Page): Promise<void> {
        this.logger.info('MOBILE-CHECKIN', 'Attempting daily mobile check-in...')
        await this.dashboardService.navigateToCheckIn(page)
        await page.waitForTimeout(3000)

        // The check-in button is often behind a shadow root or dynamic
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
            this.logger.debug('MOBILE-CHECKIN', 'No explicit check-in button found, may have already been claimed or is automatic')
        }

        await page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded' }).catch(() => { })
    }

    private wait(min: number, max: number): Promise<void> {
        const delay = min + Math.floor(Math.random() * (max - min))
        return new Promise(r => setTimeout(r, delay))
    }
}
