/**
 * API-Based Quiz Handler
 * Completes quiz tasks via POST to bing.com/bingqa/ReportActivity
 */

import axios, { type AxiosRequestConfig } from 'axios'
import type { Cookie } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import type { BasePromotion } from '../../types'
import type { DashboardService } from '../DashboardService'
import { Logger } from '../../logging/Logger'

export class ApiQuiz {
    private logger: Logger
    private dashboardService: DashboardService
    private cookies: Cookie[]
    private fingerprint: BrowserFingerprintWithHeaders

    constructor(
        logger: Logger,
        dashboardService: DashboardService,
        cookies: Cookie[],
        fingerprint: BrowserFingerprintWithHeaders
    ) {
        this.logger = logger
        this.dashboardService = dashboardService
        this.cookies = cookies
        this.fingerprint = fingerprint
    }

    async execute(promotion: BasePromotion): Promise<void> {
        const offerId = promotion.offerId
        let oldBalance = await this.dashboardService.getCurrentPoints(this.cookies, this.fingerprint).catch(() => 0)

        this.logger.info(
            'QUIZ',
            `Starting quiz | offerId=${offerId} | pointProgressMax=${promotion.pointProgressMax} | activityProgressMax=${promotion.activityProgressMax ?? 'unknown'} | currentPoints=${oldBalance}`
        )

        try {
            // 8-question quizzes are not supported (activityProgressMax=80)
            if (promotion.activityProgressMax === 80) {
                this.logger.warn('QUIZ', `Detected 8-question quiz (activityProgressMax=80), skipping | offerId=${offerId}`)
                return
            }

            // Standard points quizzes (10/20/30/40/50 max), excluding polls (handled in ActivityRunner)
            if ([10, 20, 30, 40, 50].includes(promotion.pointProgressMax)) {
                const cookieHeader = this.dashboardService.buildCookieHeader(this.cookies, [
                    'bing.com', 'live.com', 'microsoftonline.com'
                ])

                const fingerprintHeaders = { ...this.fingerprint.headers }
                delete fingerprintHeaders['Cookie']
                delete fingerprintHeaders['cookie']

                const maxAttempts = 20
                let totalGained = 0
                let attempts = 0

                this.logger.debug('QUIZ', `Starting ReportActivity loop | offerId=${offerId} | maxAttempts=${maxAttempts}`)

                for (let i = 0; i < maxAttempts; i++) {
                    try {
                        const jsonData = {
                            UserId: null,
                            TimeZoneOffset: -60,
                            OfferId: offerId,
                            ActivityCount: 1,
                            QuestionIndex: '-1'
                        }

                        const request: AxiosRequestConfig = {
                            url: 'https://www.bing.com/bingqa/ReportActivity?ajaxreq=1',
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                cookie: cookieHeader,
                                ...fingerprintHeaders
                            },
                            data: JSON.stringify(jsonData)
                        }

                        this.logger.debug('QUIZ', `Sending ReportActivity | attempt=${i + 1}/${maxAttempts} | offerId=${offerId}`)
                        const response = await axios.request(request)

                        const newBalance = await this.dashboardService.getCurrentPoints(this.cookies, this.fingerprint).catch(() => oldBalance)
                        const gainedPoints = newBalance - oldBalance
                        attempts = i + 1

                        if (gainedPoints > 0) {
                            oldBalance = newBalance
                            totalGained += gainedPoints

                            this.logger.info(
                                'QUIZ',
                                `ReportActivity ${i + 1} → ${response.status} | offerId=${offerId} | +${gainedPoints} pts | balance=${newBalance}`
                            )
                        } else {
                            this.logger.warn('QUIZ', `ReportActivity ${i + 1} | offerId=${offerId} | no more points, ending quiz`)
                            break
                        }

                        // Wait between attempts
                        await this.wait(5000, 7000)
                    } catch (error) {
                        this.logger.error(
                            'QUIZ',
                            `Error during ReportActivity | attempt=${i + 1}/${maxAttempts} | offerId=${offerId} | ${error instanceof Error ? error.message : String(error)}`
                        )
                        break
                    }
                }

                this.logger.info(
                    'QUIZ',
                    `Quiz completed | offerId=${offerId} | attempts=${attempts} | totalGained=${totalGained}`
                )
            } else {
                this.logger.warn(
                    'QUIZ',
                    `Unsupported quiz config | offerId=${offerId} | pointProgressMax=${promotion.pointProgressMax} | activityProgressMax=${promotion.activityProgressMax}`
                )
            }
        } catch (error) {
            this.logger.error(
                'QUIZ',
                `Error in doQuiz | offerId=${offerId} | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private wait(min: number, max: number): Promise<void> {
        const delay = min + Math.floor(Math.random() * (max - min))
        return new Promise(r => setTimeout(r, delay))
    }
}
