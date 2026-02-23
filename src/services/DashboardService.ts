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
import { UIService } from './UIService'

export class DashboardService {
    private logger: Logger
    private uiService?: UIService

    constructor(logger: Logger, uiService?: UIService) {
        this.logger = logger
        this.uiService = uiService
    }

    /**
     * Fetch dashboard data from the Microsoft Rewards API.
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

        // Fallback: direct page extraction if page is available
        if (page) {
            try {
                this.logger.debug('DASHBOARD-API', 'Trying page.evaluate fallback to extract dashboard data...')
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

        throw new Error('Failed to fetch dashboard data')
    }

    /**
     * Expand all collapsed sections on the dashboard.
     */
    async expandDashboardSections(page: Page, _data?: DashboardData): Promise<void> {
        this.logger.info('DASHBOARD-UI', 'Attempting to expand dashboard sections...')

        if (!this.uiService) {
            this.logger.warn('DASHBOARD-UI', 'UIService not available, skipping expansion')
            return
        }

        const sections = [
            { name: 'Daily set', goal: 'Find the expansion toggle for Daily Set' },
            { name: 'Keep earning', goal: 'Find the expansion toggle for More Activities or Keep Earning' },
            { name: 'Your activity', goal: 'Find the expansion toggle for Point History or Your Activity' },
            { name: 'More promotions', goal: 'Find the expansion toggle for More Promotions' }
        ]

        for (const section of sections) {
            const isCritical = ['Daily set', 'Keep earning'].includes(section.name)
            let expanded = false
            let attempts = 0

            while (!expanded) {
                attempts++
                this.logger.info('DASHBOARD-UI', `Attempting to expand section: ${section.name} (Attempt ${attempts})...`)

                expanded = await this.uiService.clickResiliently(page, {
                    text: [section.name, 'See more'],
                    role: 'toggle',
                    aiGoal: section.goal
                })

                if (expanded) {
                    this.logger.info('DASHBOARD-UI', `Successfully expanded section: ${section.name}`)
                    await page.waitForTimeout(1000) // Wait after successful expansion
                    break
                }

                if (isCritical) {
                    this.logger.warn('DASHBOARD-UI', `CRITICAL: Failed to expand ${section.name}. Retrying in 2s...`)
                    await new Promise(r => setTimeout(r, 2000))
                    // Re-scan/wait a bit for UI to settle
                    await page.waitForTimeout(1000)
                } else {
                    this.logger.warn('DASHBOARD-UI', `Optional section ${section.name} failed to expand. skipping.`)
                    break // Non-critical, move on
                }
            }
        }
    }

    /**
     * Get current point balance.
     */
    async getCurrentPoints(cookies: Cookie[], fingerprint: BrowserFingerprintWithHeaders): Promise<number> {
        const data = await this.getDashboardData(cookies, fingerprint)
        return data.userStatus.availablePoints
    }

    /**
     * Extract RequestVerificationToken.
     */
    async getRequestToken(page: Page): Promise<string | null> {
        this.logger.info('DASHBOARD-API', 'Extracting RequestVerificationToken...')
        return await page.evaluate(() => {
            const input = document.querySelector('input[name="__RequestVerificationToken"]') as HTMLInputElement
            return input?.value || null
        })
    }

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

    /**
     * Navigate to the Activity/Point history page.
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
}
