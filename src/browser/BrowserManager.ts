/**
 * Browser Manager
 * Manages Patchright browser instances with anti-detection
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'patchright'
import { FingerprintGenerator } from 'fingerprint-generator'
import { FingerprintInjector } from 'fingerprint-injector'
import type { Account, BrowserSession } from '../types'
import { Logger } from '../logging/Logger'
import { Utils } from '../util/Utils'

export class BrowserManager {
    private logger: Logger
    private utils: Utils
    private browser: Browser | null = null
    private fingerprintGenerator: FingerprintGenerator
    private fingerprintInjector: FingerprintInjector

    constructor(logger: Logger, utils: Utils) {
        this.logger = logger
        this.utils = utils
        this.fingerprintGenerator = new FingerprintGenerator()
        this.fingerprintInjector = new FingerprintInjector()
    }

    /**
     * Launch browser with anti-detection and specific window size
     */
    async launchBrowser(headless: boolean = true, isMobile: boolean = false): Promise<Browser> {
        this.logger.info('BROWSER', `Launching Patchright browser (headless: ${headless}, mobile: ${isMobile})`)

        if (this.browser) {
            await this.browser.close()
        }

        const windowSize = isMobile ? '375,812' : '1920,1080'

        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            ...(!isMobile ? ['--start-maximized'] : []),
            `--window-size=${windowSize}`
        ]

        try {
            // Try launching with Chrome channel first (often more stable/trusted than pure Chromium)
            this.logger.debug('BROWSER', 'Attempting to launch Google Chrome...')
            this.browser = await chromium.launch({
                headless: headless,
                channel: 'chrome',
                args: args
            })
            this.logger.info('BROWSER', 'Google Chrome launched successfully')
        } catch (error) {
            this.logger.warn('BROWSER', `Failed to launch Google Chrome, falling back to bundled Chromium. Error: ${error instanceof Error ? error.message : String(error)}`)

            // Fallback to bundled Chromium
            this.browser = await chromium.launch({
                headless: headless,
                args: args
            })
            this.logger.info('BROWSER', 'Bundled Chromium launched successfully')
        }

        return this.browser
    }

    /**
     * Create browser context with fingerprint injection
     */
    async createContext(account: Account, isMobile: boolean): Promise<BrowserSession> {
        if (!this.browser) {
            throw new Error('Browser not launched. Call launchBrowser() first')
        }

        this.logger.info('BROWSER', `Creating context for ${account.email} (mobile: ${isMobile})`)

        // Generate realistic fingerprint
        const fingerprint = this.fingerprintGenerator.getFingerprint({
            devices: [isMobile ? 'mobile' : 'desktop'],
            locales: ['en-US'],
            browsers: ['chrome'],
            operatingSystems: [isMobile ? 'android' : 'windows']
        })

        // Randomized mobile user agents (Edge mobile — required for MS Rewards mobile search points)
        const mobileDevices = [
            'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0',
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0',
            'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0',
            'Mozilla/5.0 (Linux; Android 13; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0',
            'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0',
            'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0'
        ]

        // Randomized desktop user agents (Edge desktop — newer versions)
        const desktopDevices = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0'
        ]

        // Pick user agent
        const randomMobile = mobileDevices[Math.floor(Math.random() * mobileDevices.length)]
        const randomDesktop = desktopDevices[Math.floor(Math.random() * desktopDevices.length)]
        const userAgent = isMobile ? randomMobile : randomDesktop

        this.logger.info('BROWSER', `Using user agent: ${userAgent.substring(0, 80)}...`)

        // Set dimensions
        const viewport = isMobile ? { width: 375, height: 812 } : { width: 1920, height: 1080 }

        const context = await this.browser.newContext({
            userAgent: userAgent,
            viewport: viewport,
            screen: viewport,
            deviceScaleFactor: isMobile ? 3 : 1, // Higher scale for mobile (Retina-like)
            isMobile: isMobile,
            hasTouch: isMobile,
            locale: 'en-US',
            timezoneId: 'America/New_York',
            permissions: ['geolocation', 'notifications'],
            extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9',
                // Client Hints headers — critical for mobile detection by Bing/Rewards
                'sec-ch-ua-mobile': isMobile ? '?1' : '?0',
                'sec-ch-ua-platform': isMobile ? '"Android"' : '"Windows"',
            },
            proxy: account.proxy ? {
                server: `${account.proxy.protocol}://${account.proxy.host}:${account.proxy.port}`,
                username: account.proxy.username,
                password: account.proxy.password
            } : undefined
        })

        // Update the fingerprint object to match our chosen user agent and environment before injection
        if (fingerprint.fingerprint) {
            if (fingerprint.fingerprint.navigator) {
                fingerprint.fingerprint.navigator.userAgent = userAgent
                // Critical mobile signals that must match our context settings
                fingerprint.fingerprint.navigator.platform = isMobile ? 'Linux armv81' : 'Win32'
                fingerprint.fingerprint.navigator.maxTouchPoints = isMobile ? 5 : 0
                // Override userAgentData to match mobile/desktop
                if (fingerprint.fingerprint.navigator.userAgentData) {
                    fingerprint.fingerprint.navigator.userAgentData.mobile = isMobile
                    fingerprint.fingerprint.navigator.userAgentData.platform = isMobile ? 'Android' : 'Windows'
                }
            }
            if (fingerprint.fingerprint.screen) {
                fingerprint.fingerprint.screen.width = viewport.width
                fingerprint.fingerprint.screen.height = viewport.height
                fingerprint.fingerprint.screen.availWidth = viewport.width
                fingerprint.fingerprint.screen.availHeight = viewport.height
            }
        }

        // Inject fingerprint into Playwright context
        await this.fingerprintInjector.attachFingerprintToPlaywright(context as any, fingerprint as any)

        this.logger.info('BROWSER', 'Context created with environment-specific parameters')

        return {
            context,
            fingerprint: fingerprint as any,
            cookies: {
                desktop: [],
                mobile: []
            }
        }
    }

    /**
     * Create new page in context
     */
    async createPage(context: BrowserContext): Promise<Page> {
        const page = await context.newPage()
        return page
    }

    /**
     * Navigate to URL with retry and timeout handling
     */
    async goto(page: Page, url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'networkidle'): Promise<void> {
        this.logger.debug('BROWSER', `Navigating to: ${url}`)

        await this.utils.retryWithBackoff(async () => {
            await page.goto(url, {
                waitUntil,
                timeout: 30000
            })
        }, 3, 2000)

        // Random delay after navigation
        await this.utils.wait(this.utils.randomDelay(500, 1500))
    }

    /**
     * Close context
     */
    async closeContext(context: BrowserContext): Promise<void> {
        await context.close()
        this.logger.debug('BROWSER', 'Context closed')
    }

    /**
     * Close browser
     */
    async closeBrowser(): Promise<void> {
        if (this.browser) {
            await this.browser.close()
            this.browser = null
            this.logger.info('BROWSER', 'Browser closed')
        }
    }
}
