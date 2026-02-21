/**
 * Dashboard Service
 * Fetches dashboard data from Microsoft Rewards API and manages request tokens.
 * Replaces DOM-based task discovery with API calls.
 */

import type { Cookie, Page } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import axios, { type AxiosRequestConfig } from 'axios'
import type { DashboardData } from '../types'
import { Logger } from '../logging/Logger'

export class DashboardService {
    private logger: Logger

    constructor(logger: Logger) {
        this.logger = logger
    }

    /**
     * Build a cookie header string from browser cookies, optionally filtering by domain.
     */
    buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string {
        return [
            ...new Map(
                cookies
                    .filter(c => {
                        if (!allowedDomains || allowedDomains.length === 0) return true
                        return (
                            typeof c.domain === 'string' &&
                            allowedDomains.some(d => c.domain.toLowerCase().endsWith(d.toLowerCase()))
                        )
                    })
                    .map(c => [c.name, c] as const)
            ).values()
        ]
            .map(c => `${c.name}=${c.value}`)
            .join('; ')
    }

    /**
     * Fetch dashboard data from the Microsoft Rewards API.
     * Falls back to HTML scraping, then to page.evaluate if the API endpoint fails.
     */
    async getDashboardData(
        cookies: Cookie[],
        fingerprint: BrowserFingerprintWithHeaders,
        page?: Page
    ): Promise<DashboardData> {
        const cookieHeader = this.buildCookieHeader(cookies, [
            'bing.com',
            'live.com',
            'microsoftonline.com'
        ])

        // Primary: JSON API
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

        // Fallback 1: HTML scraping with multiple patterns
        try {
            const request: AxiosRequestConfig = {
                url: 'https://rewards.bing.com/',
                method: 'GET',
                headers: {
                    ...(fingerprint?.headers ?? {}),
                    Cookie: this.buildCookieHeader(cookies),
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com'
                }
            }

            this.logger.debug('DASHBOARD-API', 'Fetching dashboard data from HTML fallback...')
            const response = await axios.request(request)
            const html = response.data as string

            // Try multiple patterns for extracting dashboard data
            const patterns = [
                /var\s+dashboard\s*=\s*({.*?});/s,
                /"dashboard"\s*:\s*({.*?})\s*[,}]/s,
                /window\.dashboard\s*=\s*({.*?});/s,
                /__NEXT_DATA__.*?"dashboard"\s*:\s*({.*?})\s*[,}]/s
            ]

            for (const pattern of patterns) {
                const match = html.match(pattern)
                if (match?.[1]) {
                    try {
                        const data = JSON.parse(match[1]) as DashboardData
                        this.logger.info('DASHBOARD-API', 'Dashboard data fetched successfully via HTML fallback')
                        return data
                    } catch { /* parse failed, try next pattern */ }
                }
            }

            this.logger.warn('DASHBOARD-API', 'HTML fallback: no matching patterns in page source')
        } catch (fallbackError) {
            this.logger.warn(
                'DASHBOARD-API',
                `HTML fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
            )
        }

        // Fallback 2: Direct page evaluation (extracts from the live browser context)
        if (page) {
            try {
                this.logger.debug('DASHBOARD-API', 'Trying page.evaluate fallback to extract dashboard data...')

                // Navigate to the rewards page if not already there
                const currentUrl = page.url()
                if (!currentUrl.includes('rewards.bing.com')) {
                    await page.goto('https://rewards.bing.com/', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => { })
                }

                // Try to extract dashboard data from the page's JavaScript context
                const dashData = await page.evaluate(() => {
                    // Check for window.dashboard (legacy)
                    if ((window as any).dashboard) return (window as any).dashboard

                    // Check for __NEXT_DATA__ (React/Next.js)
                    if ((window as any).__NEXT_DATA__?.props?.pageProps?.dashboard) {
                        return (window as any).__NEXT_DATA__.props.pageProps.dashboard
                    }

                    // Check for any script tag with dashboard JSON
                    const scripts = Array.from(document.querySelectorAll('script'))
                    for (const script of scripts) {
                        const text = script.textContent || ''
                        if (text.includes('dailySetPromotions') && text.includes('userStatus')) {
                            // Try to extract JSON from script content
                            const match = text.match(/\{.*"userStatus".*"dailySetPromotions".*\}/s)
                                || text.match(/\{.*"dailySetPromotions".*"userStatus".*\}/s)
                            if (match) {
                                try { return JSON.parse(match[0]) } catch { /* ignore */ }
                            }
                        }
                    }

                    return null
                })

                if (dashData) {
                    this.logger.info('DASHBOARD-API', 'Dashboard data extracted via page.evaluate fallback')
                    return dashData as DashboardData
                }

                this.logger.warn('DASHBOARD-API', 'page.evaluate fallback found no dashboard data')
            } catch (pageError) {
                this.logger.warn(
                    'DASHBOARD-API',
                    `page.evaluate fallback failed: ${pageError instanceof Error ? pageError.message : String(pageError)}`
                )
            }
        }

        // All methods failed
        throw new Error('All dashboard data extraction methods failed (API, HTML, page.evaluate)')
    }

    /**
     * Get current point balance by fetching dashboard data.
     */
    async getCurrentPoints(
        cookies: Cookie[],
        fingerprint: BrowserFingerprintWithHeaders
    ): Promise<number> {
        try {
            const data = await this.getDashboardData(cookies, fingerprint)
            return data.userStatus.availablePoints
        } catch (error) {
            this.logger.error(
                'DASHBOARD-API',
                `Failed to get current points: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    /**
     * Extract the __RequestVerificationToken from the rewards page.
     * This token is required for all reportactivity API calls.
     */
    async getRequestToken(page: Page): Promise<string | null> {
        this.logger.info('DASHBOARD-API', 'Extracting RequestVerificationToken from rewards page...')

        try {
            // Make sure we're on the rewards page
            const url = new URL(page.url())
            if (url.hostname !== 'rewards.bing.com') {
                await page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { })
            } else {
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { })
            }

            // Wait for the token input to be present in the DOM
            try {
                await page.waitForSelector('input[name="__RequestVerificationToken"]', { timeout: 3000 })
            } catch {
                this.logger.debug('DASHBOARD-API', 'Token input selector timed out, trying manual extraction strategies')
            }

            // Strategy 1: Standard DOM elements
            let token = await page.evaluate(() => {
                const input = document.querySelector('input[name="__RequestVerificationToken"]') as HTMLInputElement
                if (input?.value) return input.value

                const meta = document.querySelector('meta[name="__RequestVerificationToken"]') as HTMLMetaElement
                if (meta?.content) return meta.content

                return null
            })

            // Strategy 2: Regex on full HTML content (for Next.js/React hydration data)
            if (!token) {
                this.logger.debug('DASHBOARD-API', 'DOM extraction failed, checking page source via Regex...')
                const content = await page.content()

                // Common patterns for the token in source
                const patterns = [
                    /name="__RequestVerificationToken" value="([^"]+)"/,
                    /__RequestVerificationToken":"([^"]+)"/,
                    /RequestVerificationToken: '([^']+)'/,
                    /requestVerificationToken = "([^"]+)"/,
                    /"__RequestVerificationToken","value":"([^"]+)"/,
                    /input .* name="__RequestVerificationToken" .* value="([^"]+)"/i,
                    /<input[^>]+name="__RequestVerificationToken"[^>]+value="([^"]+)"/i
                ]

                for (const pattern of patterns) {
                    const match = content.match(pattern)
                    if (match?.[1]) {
                        this.logger.debug('DASHBOARD-API', `RequestVerificationToken extracted via pattern: ${pattern}`)
                        token = match[1]
                        break
                    }
                }
            }

            if (token) {
                this.logger.info('DASHBOARD-API', `RequestVerificationToken retrieved: ${token.substring(0, 10)}...`)
                return token
            }

            this.logger.warn('DASHBOARD-API', 'RequestVerificationToken not found on page')
            return null
        } catch (error) {
            this.logger.error(
                'DASHBOARD-API',
                `Failed to extract RequestVerificationToken: ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    /**
     * Get today's date key in the format used by dailySetPromotions.
     * Format: MM/DD/YYYY
     */
    getFormattedDate(): string {
        const date = new Date()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const year = date.getFullYear()
        return `${month}/${day}/${year}`
    }

    /**
     * Detect which UI version is active on the current page.
     * Old UI: uses `.pointLink` and `[data-bi-id]` attributes
     * New UI: React-based with collapsible chevron sections
     */
    async detectUIVersion(page: Page): Promise<'old' | 'new'> {
        try {
            const uiType = await page.evaluate(() => {
                // Old UI markers
                const hasPointLink = document.querySelectorAll('.pointLink').length > 0
                const hasBiId = document.querySelectorAll('[data-bi-id]').length > 0
                // Old UI typically has a #more-activities container
                const hasMoreActivities = !!document.querySelector('#more-activities')

                // New UI markers — chevron SVG buttons inside small containers
                const buttons = Array.from(document.querySelectorAll('button'))
                const hasChevronButtons = buttons.some(btn => {
                    const svg = btn.querySelector('svg')
                    if (!svg) return false
                    const text = btn.textContent?.trim() || ''
                    if (text.length > 5) return false
                    const rect = btn.getBoundingClientRect()
                    return rect.width > 0 && rect.width <= 60 && rect.height > 0 && rect.height <= 60
                })

                // New UI uses React-style data attributes
                const hasReactAttrs = document.querySelectorAll('[data-rac], [data-react-aria-pressable]').length > 0

                // Decision: if old UI markers are strong, call it old
                if (hasPointLink && hasBiId && !hasChevronButtons) return 'old'
                if (hasChevronButtons || hasReactAttrs) return 'new'
                // Default: if pointLink exists, it's likely old
                if (hasPointLink || hasMoreActivities) return 'old'
                return 'new'
            })

            this.logger.info('DASHBOARD-UI', `Detected UI version: ${uiType}`)
            return uiType
        } catch (error) {
            this.logger.warn('DASHBOARD-UI', `UI detection failed, defaulting to 'new': ${error instanceof Error ? error.message : String(error)}`)
            return 'new'
        }
    }

    /**
     * Expand all collapsed sections on the dashboard.
     * Uses a resilient re-scanning loop to handle DOM re-renders caused by React state updates.
     */
    async expandDashboardSections(page: Page, _data?: DashboardData): Promise<void> {
        this.logger.info('DASHBOARD-UI', 'Expanding collapsed dashboard sections...')

        try {
            await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { })

            // === Strategy 1: Old UI — simple clicks ===
            const oldUiBtn = await page.$('#more-activities')
            if (oldUiBtn) {
                await oldUiBtn.click({ force: true }).catch(() => { })
                this.logger.info('DASHBOARD-UI', 'Clicked old UI #more-activities')
                await page.waitForTimeout(500)
            }
            const seeMoreBtns = await page.$$('a.seeMoreLink, button.seeMoreLink, [data-bi-id="seeMore"]')
            for (const btn of seeMoreBtns) {
                await btn.click({ force: true }).catch(() => { })
            }

            // === Strategy 2: New UI — Resilient re-scanning loop ===
            // We re-scan the DOM in every iteration because clicking one toggle 
            // often causes React to re-render siblings or shift the layout.
            let expandedCount = 0
            const maxAttempts = 12 // Safety limit
            const clickedIds = new Set<string>()

            for (let i = 0; i < maxAttempts; i++) {
                // Find the next best candidate to expand
                const targetId = await page.evaluate(() => {
                    const sections = ['daily set', 'keep earning', 'more promotions',
                        'more activities', 'your perks', 'your progress',
                        'achievements', 'streak bonus', 'featured redemptions']

                    const allButtons = Array.from(document.querySelectorAll('button'))

                    for (const btn of allButtons) {
                        // Identify potential toggle buttons
                        // Heuristic: slot="trigger", data-rac, or chevron-like small button
                        const isTrigger = btn.getAttribute('slot') === 'trigger' || btn.hasAttribute('data-rac')
                        const hasSvg = btn.querySelector('svg') !== null
                        const isSmall = btn.offsetWidth < 70 && btn.offsetHeight < 70
                        const isToggle = isTrigger || (hasSvg && isSmall) || btn.getAttribute('aria-label') === 'Daily set'

                        if (isToggle) {
                            // Check if it's already expanded
                            const ariaExpanded = btn.getAttribute('aria-expanded')

                            // If it says false, we definitely need to click it
                            if (ariaExpanded === 'false') {
                                // Keep going to known section check
                            }
                            // If it says true, check if it's actually expanded
                            else if (ariaExpanded === 'true') {
                                const controlsId = btn.getAttribute('aria-controls')
                                const controlledEl = controlsId ? document.getElementById(controlsId) : null

                                // If we can find the controlled element and it has 0 height, it's NOT truly expanded
                                if (controlledEl && controlledEl.offsetHeight > 0) {
                                    continue // Truly expanded, skip
                                }
                                // If no controlled element found, fallback to SVG rotation or just skip
                            } else {
                                // No aria-expanded attribute, but is a toggle candidate
                            }

                            // Check if it's a known section header
                            let isKnownSection = false
                            let parent = btn.parentElement
                            for (let j = 0; j < 10 && parent; j++) {
                                const text = (parent as HTMLElement).innerText?.toLowerCase() || ''
                                if (sections.some(s => text.includes(s))) {
                                    isKnownSection = true
                                    break
                                }
                                parent = parent.parentElement
                            }

                            // If it's a trigger, or a known section small toggle
                            if (isTrigger || isKnownSection) {
                                if (!btn.id) {
                                    btn.id = `temp-expand-${Math.random().toString(36).substr(2, 9)}`
                                }
                                return btn.id
                            }
                        }
                    }
                    return null
                })

                if (!targetId || clickedIds.has(targetId)) break

                try {
                    const selector = `#${targetId}`
                    const sectionName = await page.$eval(selector, (btn) => {
                        let parent = btn.parentElement
                        for (let j = 0; j < 8 && parent; j++) {
                            const text = (parent as HTMLElement).innerText?.toLowerCase() || ''
                            const names = ['daily set', 'keep earning', 'more promotions', 'more activities', 'your perks', 'your progress', 'achievements']
                            for (const n of names) if (text.includes(n)) return n
                            parent = parent.parentElement
                        }
                        return 'unknown'
                    }).catch(() => 'unknown')

                    await page.click(selector, { timeout: 3000, force: true })
                    clickedIds.add(targetId)
                    expandedCount++
                    this.logger.info('DASHBOARD-UI', `Expanded section: "${sectionName}"`)
                    await page.waitForTimeout(600) // Wait for animation
                } catch (e) {
                    this.logger.debug('DASHBOARD-UI', `Skipping toggle ${targetId} due to error or re-render`)
                    clickedIds.add(targetId) // Don't try same failing one again in this run
                }
            }

            if (expandedCount > 0) {
                this.logger.info('DASHBOARD-UI', `Dashboard expansion complete (expanded ${expandedCount} sections)`)
                await page.waitForTimeout(500)
            } else {
                this.logger.debug('DASHBOARD-UI', 'No collapsed sections found or all attempts failed.')
            }

        } catch (error) {
            this.logger.warn('DASHBOARD-UI', `Error during expansion: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
}
