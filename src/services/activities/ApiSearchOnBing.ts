/**
 * API-Based Search On Bing Handler
 * Activates search task via API, then performs browser-based searches.
 */

import axios, { type AxiosRequestConfig } from 'axios'
import type { Cookie, Page } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import type { BasePromotion } from '../../types'
import type { DashboardService } from '../DashboardService'
import { Logger } from '../../logging/Logger'

export class ApiSearchOnBing {
    private logger: Logger
    private dashboardService: DashboardService
    private requestToken: string
    private cookies: Cookie[]
    private fingerprint: BrowserFingerprintWithHeaders

    constructor(
        logger: Logger,
        dashboardService: DashboardService,
        requestToken: string,
        cookies: Cookie[],
        fingerprint: BrowserFingerprintWithHeaders
    ) {
        this.logger = logger
        this.dashboardService = dashboardService
        this.requestToken = requestToken
        this.cookies = cookies
        this.fingerprint = fingerprint
    }

    async execute(promotion: BasePromotion, page: Page): Promise<void> {
        const offerId = promotion.offerId
        const oldBalance = await this.dashboardService.getCurrentPoints(this.cookies, this.fingerprint).catch(() => 0)

        this.logger.info('SEARCH-ON-BING', `Starting SearchOnBing | offerId=${offerId} | title="${promotion.title}" | currentPoints=${oldBalance}`)

        try {
            // Step 1: Activate the search task via API
            const activated = await this.activateSearchTask(promotion)
            if (!activated) {
                this.logger.warn('SEARCH-ON-BING', `Search activity couldn't be activated, aborting | offerId=${offerId}`)
                return
            }

            // Step 2: Get search queries
            const queries = await this.getSearchQueries(promotion)

            // Step 3: Perform browser searches
            await this.searchBing(page, queries, offerId, oldBalance)

            const finalBalance = await this.dashboardService.getCurrentPoints(this.cookies, this.fingerprint).catch(() => oldBalance)
            const totalGained = finalBalance - oldBalance

            if (totalGained > 0) {
                this.logger.info('SEARCH-ON-BING', `Completed SearchOnBing | offerId=${offerId} | +${totalGained} pts | balance=${finalBalance}`)
            } else {
                this.logger.warn('SEARCH-ON-BING', `SearchOnBing finished with no points | offerId=${offerId}`)
            }
        } catch (error) {
            this.logger.error(
                'SEARCH-ON-BING',
                `Error in SearchOnBing | offerId=${offerId} | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async activateSearchTask(promotion: BasePromotion): Promise<boolean> {
        try {
            const cookieHeader = this.dashboardService.buildCookieHeader(this.cookies, [
                'bing.com', 'live.com', 'microsoftonline.com'
            ])

            const formData = new URLSearchParams({
                id: promotion.offerId,
                hash: promotion.hash,
                timeZone: '60',
                activityAmount: '1',
                dbs: '0',
                form: '',
                type: '',
                __RequestVerificationToken: this.requestToken
            })

            const request: AxiosRequestConfig = {
                url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
                method: 'POST',
                headers: {
                    ...(this.fingerprint?.headers ?? {}),
                    Cookie: cookieHeader,
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com'
                },
                data: formData
            }

            const response = await axios.request(request)
            this.logger.info('SEARCH-ON-BING', `Activated search task | status=${response.status} | offerId=${promotion.offerId}`)
            return true
        } catch (error) {
            this.logger.error(
                'SEARCH-ON-BING',
                `Activation failed | offerId=${promotion.offerId} | ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    private async searchBing(page: Page, queries: string[], _offerId: string, oldBalance: number): Promise<void> {
        queries = [...new Set(queries)]
        this.logger.debug('SEARCH-ON-BING', `Starting search loop | queriesCount=${queries.length}`)

        let i = 0
        for (const query of queries) {
            try {
                this.logger.debug('SEARCH-ON-BING', `Processing query | query="${query}"`)

                await page.goto('https://bing.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { })
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { })

                const searchBox = page.locator('#sb_form_q')
                await searchBox.waitFor({ state: 'attached', timeout: 15000 })

                await this.wait(300, 600)
                await searchBox.click({ clickCount: 3 }).catch(() => { })
                await searchBox.fill('')
                await page.keyboard.type(query, { delay: 50 })
                await page.keyboard.press('Enter')

                await this.wait(5000, 7000)

                // Check for point updates
                const newBalance = await this.dashboardService.getCurrentPoints(this.cookies, this.fingerprint).catch(() => oldBalance)
                const gainedPoints = newBalance - oldBalance

                if (gainedPoints > 0) {
                    this.logger.info('SEARCH-ON-BING', `Search query earned points | query="${query}" | +${gainedPoints} pts | balance=${newBalance}`)
                    return // Success, done
                } else {
                    this.logger.warn('SEARCH-ON-BING', `${++i}/${queries.length} | no points | query="${query}"`)
                }
            } catch (error) {
                this.logger.error(
                    'SEARCH-ON-BING',
                    `Error during search | query="${query}" | ${error instanceof Error ? error.message : String(error)}`
                )
            } finally {
                await this.wait(5000, 15000)
                await page.goto('https://rewards.bing.com/', { timeout: 5000 }).catch(() => { })
            }
        }

        this.logger.warn('SEARCH-ON-BING', `Finished all queries with no points | queriesTried=${queries.length}`)
    }

    private async getSearchQueries(promotion: BasePromotion): Promise<string[]> {
        try {
            // Try fetching from TheNetsky's remote query database
            this.logger.debug('SEARCH-ON-BING', 'Fetching search queries from remote repository')

            const response = await axios.request({
                method: 'GET',
                url: 'https://raw.githubusercontent.com/TheNetsky/Microsoft-Rewards-Script/refs/heads/v3/src/functions/bing-search-activity-queries.json',
                timeout: 10000
            })

            const queries: Array<{ title: string; queries: string[] }> = response.data

            // Find matching queries for this promotion
            const normalizedTitle = promotion.title.toLowerCase().trim()
            const answers = queries.find(
                x => x.title.toLowerCase().trim() === normalizedTitle
            )

            if (answers && answers.queries.length > 0) {
                // Shuffle the answers
                const shuffled = [...answers.queries].sort(() => Math.random() - 0.5)
                this.logger.info('SEARCH-ON-BING', `Found ${shuffled.length} matching queries for "${promotion.title}"`)
                return shuffled
            }

            this.logger.info('SEARCH-ON-BING', `No matching queries for "${promotion.title}", using Bing suggestions`)

            // Fallback to promotion description
            const desc = promotion.title.toLowerCase().replace('search on bing', '').trim()
            if (desc) {
                // Try bing suggestions API
                try {
                    const suggestResponse = await axios.get(
                        `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(desc)}`,
                        { timeout: 5000 }
                    )
                    if (suggestResponse.data?.[1]?.length > 0) {
                        this.logger.info('SEARCH-ON-BING', `Got ${suggestResponse.data[1].length} Bing suggestions`)
                        return suggestResponse.data[1]
                    }
                } catch {
                    // Ignore suggestion failures
                }
            }

            // Last resort: use the promotion title itself
            return [promotion.title]
        } catch (error) {
            this.logger.error(
                'SEARCH-ON-BING',
                `Error resolving queries | title="${promotion.title}" | ${error instanceof Error ? error.message : String(error)}`
            )
            return [promotion.title]
        }
    }

    private wait(min: number, max: number): Promise<void> {
        const delay = min + Math.floor(Math.random() * (max - min))
        return new Promise(r => setTimeout(r, delay))
    }
}
