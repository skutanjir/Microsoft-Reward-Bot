/**
 * Dashboard Service
 * Fetches dashboard data from Microsoft Rewards API and manages request tokens.
 */

import type { Cookie, Page } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import axios, { type AxiosRequestConfig } from 'axios'
import type { DashboardData } from '../types'
import { Logger } from '../logging/Logger'
import { UIService } from './UIService'

export class DashboardService {
    private logger: Logger
    private uiService?: UIService

    constructor(logger: Logger, uiService?: UIService) {
        this.logger = logger
        this.uiService = uiService
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DASHBOARD DATA
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Fetch dashboard data from the Microsoft Rewards API.
     */
    async getDashboardData(
        cookies: Cookie[],
        fingerprint: BrowserFingerprintWithHeaders,
        page?: Page
    ): Promise<DashboardData> {
        const cookieHeader = this.buildCookieHeader(cookies, [
            'bing.com', 'live.com', 'microsoftonline.com'
        ])

        try {
            const request: AxiosRequestConfig = {
                url: 'https://rewards.bing.com/api/getuserinfo?type=1',
                method: 'GET',
                headers: {
                    ...(fingerprint?.headers ?? {}),
                    Cookie: cookieHeader,
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com'
                }
            }

            this.logger.debug('DASHBOARD-API', 'Fetching dashboard data from API...')
            const response = await axios.request(request)

            if (response.data?.dashboard) {
                this.logger.info('DASHBOARD-API', 'Dashboard data fetched successfully via API')
                return response.data.dashboard as DashboardData
            }
            throw new Error('Dashboard data missing from API response')
        } catch (error) {
            this.logger.warn(
                'DASHBOARD-API',
                `API failed: ${error instanceof Error ? error.message : String(error)}, trying HTML fallback`
            )
        }

        // Fallback: extract from page window object
        if (page) {
            try {
                this.logger.debug('DASHBOARD-API', 'Trying page.evaluate fallback...')
                const dashData = await page.evaluate(() => {
                    if ((window as any).dashboard) return (window as any).dashboard
                    if ((window as any).__NEXT_DATA__?.props?.pageProps?.dashboard) {
                        return (window as any).__NEXT_DATA__.props.pageProps.dashboard
                    }
                    return null
                })

                if (dashData) {
                    this.logger.info('DASHBOARD-API', 'Dashboard data extracted via page.evaluate')
                    return dashData as DashboardData
                }
            } catch (err) {
                this.logger.warn('DASHBOARD-API', `page.evaluate failed: ${err instanceof Error ? err.message : String(err)}`)
            }
        }

        throw new Error('Failed to fetch dashboard data via all methods')
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION EXPANSION
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Expand all collapsed sections on the dashboard.
     *
     * STRATEGY:
     *  1. Per named section: check if already open, try direct CSS, try text-match, try UIService
     *  2. Final sweep: click ALL remaining collapsed triggers on the page (catches unnamed/new sections)
     */
    async expandDashboardSections(page: Page, _data?: DashboardData): Promise<void> {
        this.logger.info('DASHBOARD-UI', 'Expanding dashboard sections...')

        const sections = [
            {
                name: 'Daily set',
                aliases: ['daily set', 'dailyset'],
                goal: 'Find the expansion toggle for the Daily Set section',
                critical: true
            },
            {
                name: 'Keep earning',
                aliases: ['keep earning', 'more activities'],
                goal: 'Find the expansion toggle for the Keep Earning / More Activities section',
                critical: true
            },
            {
                name: 'Streaks',
                aliases: ['streaks', 'streak'],
                goal: 'Find the expansion toggle for the Streaks section',
                critical: false
            },
            {
                name: 'Your activity',
                aliases: ['your activity', 'point history'],
                goal: 'Find the expansion toggle for the Your Activity / Point History section',
                critical: false
            },
            {
                name: 'More promotions',
                aliases: ['more promotions'],
                goal: 'Find the expansion toggle for the More Promotions section',
                critical: false
            }
        ]

        for (const section of sections) {
            const maxAttempts = section.critical ? 3 : 1

            let expanded = false

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                this.logger.info('DASHBOARD-UI', `Expanding "${section.name}" (attempt ${attempt}/${maxAttempts})...`)

                // First, check if already expanded — avoid toggling it closed
                const isAlreadyOpen = await this.isSectionExpanded(page, section.name, section.aliases)
                if (isAlreadyOpen) {
                    this.logger.info('DASHBOARD-UI', `Section "${section.name}" is already expanded, skipping`)
                    expanded = true
                    break
                }

                // Try direct CSS approach first (fastest) — matches aria-label OR button/heading text
                const directClicked = await this.clickCollapsedTrigger(page, section.name, section.aliases)
                if (directClicked) {
                    this.logger.info('DASHBOARD-UI', `Section "${section.name}" expanded via direct CSS ✓`)
                    await page.waitForTimeout(1000)
                    expanded = true
                    break
                }

                // Fall back to UIService multi-strategy discovery
                if (this.uiService) {
                    expanded = await this.uiService.clickResiliently(page, {
                        text: [section.name, ...section.aliases, 'See more'],
                        role: 'toggle',
                        aiGoal: section.goal
                    })

                    if (expanded) {
                        this.logger.info('DASHBOARD-UI', `Section "${section.name}" expanded via UIService ✓`)
                        await page.waitForTimeout(1000)
                        break
                    }
                }

                if (attempt < maxAttempts) {
                    const backoff = attempt * 2000
                    this.logger.warn('DASHBOARD-UI', `"${section.name}" expansion failed, retrying in ${backoff}ms...`)
                    await new Promise(r => setTimeout(r, backoff))
                    await page.waitForTimeout(500)
                }
            }

            if (!expanded) {
                const level = section.critical ? 'warn' : 'debug'
                this.logger[level]('DASHBOARD-UI', `Could not expand "${section.name}" (${section.critical ? 'critical' : 'optional'})`)
            }

            // Close any sidebar that may have opened during expansion
            await this.closeAnySidebars(page)

            // Wait 3 seconds between each section expansion
            await page.waitForTimeout(3000)
        }

        // ── Final sweep: click ALL remaining collapsed triggers ─────────────
        // This catches any sections that weren't matched by name above.
        await this.expandAllRemainingCollapsed(page)

        // ── Close any sidebars/dialogs that may have opened ─────────────────
        await this.closeAnySidebars(page)

        // ── Scroll to top so Daily Set cards are visible for clicking ───────
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })).catch(() => { })
        await page.waitForTimeout(500)
        this.logger.debug('DASHBOARD-UI', 'Scrolled to top after expansion')
    }

    /**
     * Click ALL collapsed trigger buttons remaining on the page, ONE BY ONE with delay.
     * This ensures every section is expanded regardless of name matching.
     * EXCLUDES: buttons inside dialogs, and "About ..." info buttons.
     */
    private async expandAllRemainingCollapsed(page: Page): Promise<void> {
        try {
            // Collect all collapsed triggers via page.evaluate, return their indices
            const triggerCount = await page.evaluate(() => {
                const btns = Array.from(
                    document.querySelectorAll('button[slot="trigger"][aria-expanded="false"]')
                ) as HTMLButtonElement[]

                // Filter out invalid ones
                return btns.filter(btn => {
                    const ariaLabel = (btn.getAttribute('aria-label') ?? '').toLowerCase()
                    if (ariaLabel.startsWith('about')) return false
                    if (btn.closest('[role="dialog"]')) return false
                    if (btn.offsetWidth < 40 && btn.offsetHeight < 40) return false
                    return true
                }).length
            })

            if (triggerCount === 0) {
                this.logger.debug('DASHBOARD-UI', 'Sweep: no remaining collapsed sections found')
                return
            }

            this.logger.info('DASHBOARD-UI', `Sweep: found ${triggerCount} collapsed section(s), expanding one by one...`)

            // Click them one by one with delay
            for (let i = 0; i < triggerCount; i++) {
                const clicked = await page.evaluate(() => {
                    const btns = Array.from(
                        document.querySelectorAll('button[slot="trigger"][aria-expanded="false"]')
                    ) as HTMLButtonElement[]

                    const validBtn = btns.find(btn => {
                        const ariaLabel = (btn.getAttribute('aria-label') ?? '').toLowerCase()
                        if (ariaLabel.startsWith('about')) return false
                        if (btn.closest('[role="dialog"]')) return false
                        if (btn.offsetWidth < 40 && btn.offsetHeight < 40) return false
                        return true
                    })

                    if (validBtn) {
                        validBtn.scrollIntoView({ block: 'center' })
                        validBtn.click()
                        return validBtn.getAttribute('aria-label') ?? validBtn.textContent?.trim() ?? 'unknown'
                    }
                    return null
                })

                if (clicked) {
                    this.logger.info('DASHBOARD-UI', `Sweep: expanded "${clicked}" ✓`)

                    // Close any sidebar that might have appeared
                    await this.closeAnySidebars(page)

                    // Wait 3 seconds before expanding the next one
                    if (i < triggerCount - 1) {
                        await page.waitForTimeout(3000)
                    } else {
                        await page.waitForTimeout(1000)
                    }
                } else {
                    break // No more valid triggers
                }
            }
        } catch (err) {
            this.logger.debug('DASHBOARD-UI', `Sweep failed: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    /**
     * Close any open sidebars or dialogs (e.g. "About Daily set" / "Stamp Bonus" popups).
     * Looks for [role="dialog"] sections with a Close button.
     */
    private async closeAnySidebars(page: Page): Promise<void> {
        try {
            const closed = await page.evaluate(() => {
                let count = 0
                // Find all open dialogs
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
                for (const dialog of dialogs) {
                    // Look for a close/dismiss button inside
                    const closeBtn = (
                        dialog.querySelector('button[aria-label="Close"]') ??
                        dialog.querySelector('button[aria-label="Dismiss"]') ??
                        dialog.querySelector('button[slot="close"]')
                    ) as HTMLButtonElement | null
                    if (closeBtn) {
                        closeBtn.click()
                        count++
                    }
                }
                return count
            })

            if (closed > 0) {
                this.logger.info('DASHBOARD-UI', `Closed ${closed} sidebar/dialog(s) ✓`)
                await page.waitForTimeout(800)
            }
        } catch { /* non-critical */ }
    }

    /**
     * Check if a section is already expanded by looking for expanded triggers
     * matching by aria-label OR text content of the button / nearby heading.
     */
    private async isSectionExpanded(page: Page, sectionName: string, aliases: string[]): Promise<boolean> {
        return page.evaluate(({ name, alts }) => {
            const nameLower = name.toLowerCase()
            const allNames = [nameLower, ...alts.map((a: string) => a.toLowerCase())]

            // Check button[slot="trigger"][aria-expanded="true"]
            const triggers = Array.from(
                document.querySelectorAll<HTMLButtonElement>('button[slot="trigger"][aria-expanded="true"]')
            )
            for (const btn of triggers) {
                const ariaLabel = (btn.getAttribute('aria-label') ?? '').toLowerCase()
                // Skip "About ..." info buttons — they are NOT section triggers
                if (ariaLabel.startsWith('about')) continue
                // Skip buttons inside dialogs/sidebars
                if (btn.closest('[role="dialog"]')) continue

                const btnText = (btn.textContent ?? '').toLowerCase()
                if (allNames.some(n => ariaLabel.includes(n) || btnText.includes(n))) {
                    return true
                }
            }

            // Check broader: any button[aria-expanded="true"] inside Disclosure containers
            const disclosures = Array.from(
                document.querySelectorAll<HTMLElement>('.react-aria-Disclosure, [class*="Disclosure"], section')
            )
            for (const disc of disclosures) {
                const heading = disc.querySelector('h2, h3, [slot="trigger"]')
                const headingText = (heading?.textContent ?? '').toLowerCase()
                if (allNames.some(n => headingText.includes(n))) {
                    const expandedBtn = disc.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')
                    if (expandedBtn) return true
                }
            }

            return false
        }, { name: sectionName, alts: aliases }).catch(() => false)
    }

    /**
     * Click the collapsed trigger button for a section.
     * Matches by aria-label, button text content, or heading text within the Disclosure container.
     */
    private async clickCollapsedTrigger(page: Page, sectionName: string, aliases: string[]): Promise<boolean> {
        // Strategy A: aria-label match (original approach)
        try {
            const btn = await page.$(`button[slot="trigger"][aria-label*="${sectionName}" i][aria-expanded="false"]`)
            if (btn) {
                await btn.scrollIntoViewIfNeeded().catch(() => { })
                await btn.click({ force: true })
                return true
            }
        } catch { /* next */ }

        // Strategy B: Find collapsed trigger by text content or heading text in page.evaluate
        try {
            const clicked = await page.evaluate(({ name, alts }) => {
                const allNames = [name.toLowerCase(), ...alts.map((a: string) => a.toLowerCase())]

                // B1: Check button[slot="trigger"][aria-expanded="false"] by text content
                const triggers = Array.from(
                    document.querySelectorAll<HTMLButtonElement>('button[slot="trigger"][aria-expanded="false"]')
                )
                for (const btn of triggers) {
                    const ariaLabel = (btn.getAttribute('aria-label') ?? '').toLowerCase()
                    // Skip "About ..." info buttons
                    if (ariaLabel.startsWith('about')) continue
                    // Skip buttons inside dialogs
                    if (btn.closest('[role="dialog"]')) continue

                    const btnText = (btn.textContent ?? '').toLowerCase()
                    if (allNames.some(n => ariaLabel.includes(n) || btnText.includes(n))) {
                        btn.scrollIntoView({ block: 'center' })
                        btn.click()
                        return true
                    }
                }

                // B2: Find Disclosure containers by heading text, then click their collapsed trigger
                const disclosures = Array.from(
                    document.querySelectorAll<HTMLElement>('.react-aria-Disclosure, [class*="Disclosure"], section')
                )
                for (const disc of disclosures) {
                    const heading = disc.querySelector('h2, h3, [slot="trigger"]')
                    const headingText = (heading?.textContent ?? '').toLowerCase()
                    if (allNames.some(n => headingText.includes(n))) {
                        const collapsedBtn = disc.querySelector<HTMLButtonElement>(
                            'button[slot="trigger"][aria-expanded="false"], button[aria-expanded="false"]'
                        )
                        if (collapsedBtn) {
                            collapsedBtn.scrollIntoView({ block: 'center' })
                            collapsedBtn.click()
                            return true
                        }
                    }
                }

                return false
            }, { name: sectionName, alts: aliases })

            if (clicked) return true
        } catch { /* next */ }

        // Strategy C: Playwright locator filter by text (handles shadow DOM)
        try {
            const loc = page.locator('button[slot="trigger"]')
                .filter({ hasText: new RegExp(sectionName, 'i') })
            if (await loc.count() > 0) {
                const exp = await loc.first().getAttribute('aria-expanded')
                if (exp === 'false') {
                    await loc.first().scrollIntoViewIfNeeded().catch(() => { })
                    await loc.first().click({ force: true })
                    return true
                }
            }
        } catch { /* next */ }

        return false
    }

    // ══════════════════════════════════════════════════════════════════════════
    // POINTS & TOKENS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Get current point balance.
     */
    async getCurrentPoints(cookies: Cookie[], fingerprint: BrowserFingerprintWithHeaders): Promise<number> {
        const data = await this.getDashboardData(cookies, fingerprint)
        return data.userStatus.availablePoints
    }

    /**
     * Extract RequestVerificationToken from the page DOM.
     */
    async getRequestToken(page: Page): Promise<string | null> {
        this.logger.info('DASHBOARD-API', 'Extracting RequestVerificationToken...')
        return page.evaluate(() => {
            const input = document.querySelector<HTMLInputElement>('input[name="__RequestVerificationToken"]')
            return input?.value ?? null
        })
    }

    // ══════════════════════════════════════════════════════════════════════════
    // NAVIGATION HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Navigate to the Activity / Point history page.
     */
    async navigateToActivity(page: Page): Promise<void> {
        this.logger.info('DASHBOARD', 'Navigating to Your Activity page...')
        await page.goto('https://rewards.bing.com/status/', { waitUntil: 'networkidle' })
    }

    /**
     * Navigate to the Mobile Check-in page.
     */
    async navigateToCheckIn(page: Page): Promise<void> {
        this.logger.info('DASHBOARD', 'Navigating to Mobile Check-in page...')
        await page.goto('https://rewards.bing.com/checkin', { waitUntil: 'networkidle' })
    }

    // ══════════════════════════════════════════════════════════════════════════
    // UTILITIES
    // ══════════════════════════════════════════════════════════════════════════

    public buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string {
        return cookies
            .filter(c => !allowedDomains || allowedDomains.some(d => c.domain.includes(d)))
            .map(c => `${c.name}=${c.value}`)
            .join('; ')
    }

    /**
     * Get date in M/D/YYYY format for Daily Set keys.
     */
    public getFormattedDate(): string {
        const date = new Date()
        return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`
    }
}