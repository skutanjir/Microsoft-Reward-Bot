/**
 * API-Based URL Reward Handler
 * Completes URL reward tasks via POST to rewards.bing.com/api/reportactivity
 */

import axios, { type AxiosRequestConfig } from 'axios'
import type { Cookie } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import type { BasePromotion } from '../../types'
import type { DashboardService } from '../DashboardService'
import { Logger } from '../../logging/Logger'

export class ApiUrlReward {
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

    async execute(promotion: BasePromotion): Promise<void> {
        if (!this.requestToken) {
            this.logger.warn('URL-REWARD', 'Skipping: Request token not available, this activity requires it!')
            return
        }

        const offerId = promotion.offerId
        const oldBalance = await this.dashboardService.getCurrentPoints(this.cookies, this.fingerprint).catch(() => 0)

        this.logger.info('URL-REWARD', `Starting UrlReward | offerId=${offerId} | oldBalance=${oldBalance}`)

        try {
            const cookieHeader = this.dashboardService.buildCookieHeader(this.cookies, [
                'bing.com', 'live.com', 'microsoftonline.com'
            ])

            const formData = new URLSearchParams({
                id: offerId,
                hash: promotion.hash,
                timeZone: '60',
                activityAmount: '1',
                dbs: '0',
                form: '',
                type: promotion.activityType ?? '',
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

            this.logger.debug('URL-REWARD', `Sending reportactivity | offerId=${offerId}`)
            const response = await axios.request(request)

            const newBalance = await this.dashboardService.getCurrentPoints(this.cookies, this.fingerprint).catch(() => oldBalance)
            const gainedPoints = newBalance - oldBalance

            if (gainedPoints > 0) {
                this.logger.info('URL-REWARD', `Completed UrlReward | offerId=${offerId} | status=${response.status} | +${gainedPoints} pts | balance=${newBalance}`,)
            } else {
                this.logger.warn('URL-REWARD', `UrlReward completed but no points gained | offerId=${offerId} | status=${response.status}`)
            }

            // Cooldown
            await this.wait(5000, 10000)
        } catch (error) {
            this.logger.error(
                'URL-REWARD',
                `Error in UrlReward | offerId=${offerId} | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private wait(min: number, max: number): Promise<void> {
        const delay = min + Math.floor(Math.random() * (max - min))
        return new Promise(r => setTimeout(r, delay))
    }
}
