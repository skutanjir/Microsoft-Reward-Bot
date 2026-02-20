/**
 * Login Manager
 * Handles Microsoft account authentication
 */

import type { Page, ElementHandle } from 'patchright'
import type { Account } from '../types'
import { Logger } from '../logging/Logger'
import { Utils } from '../util/Utils'

export class LoginManager {
    private logger: Logger
    private utils: Utils

    constructor(logger: Logger, utils: Utils) {
        this.logger = logger
        this.utils = utils
    }

    /**
     * Perform Microsoft account login
     */
    async login(page: Page, account: Account): Promise<void> {
        this.logger.info('LOGIN', `Logging in: ${account.email}`)

        try {
            // 1. Navigate to login page
            await page.goto('https://login.live.com', { waitUntil: 'domcontentloaded' })
            await this.utils.wait(this.utils.randomDelay(1000, 2000))

            // Check if already logged in (case of persistent session cookie not caught earlier)
            if (await this.isAtHomeOrDashboard(page)) {
                this.logger.info('LOGIN', 'Already logged in according to current page URL')
                return
            }

            // 2. Enter email
            this.logger.debug('LOGIN', 'Entering email')
            const emailInput = await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 15000 })
            await emailInput.click()
            await this.utils.wait(this.utils.randomDelay(500, 1000))

            // Type email with human-like delays
            await this.typeHumanLike(emailInput, account.email)
            await this.utils.wait(this.utils.randomDelay(800, 1500))

            // Click Next button (Microsoft usually uses id="idSIButton9")
            await this.clickPrimaryButton(page, 'Next')
            await this.utils.wait(this.utils.randomDelay(2000, 3000))

            // Check for security prompts or other hurdles
            await this.handleSecurityPrompts(page)

            // 3. Enter password
            this.logger.debug('LOGIN', 'Entering password')
            const passwordInput = await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 30000 })
            await passwordInput.click()
            await this.utils.wait(this.utils.randomDelay(500, 1000))

            // Type password with human-like delays
            await this.typeHumanLike(passwordInput, account.password)
            await this.utils.wait(this.utils.randomDelay(800, 1500))

            // Click Sign in button
            await this.clickPrimaryButton(page, 'Sign in')

            // Wait for navigation after login
            try {
                await page.waitForLoadState('networkidle', { timeout: 20000 })
            } catch (e) {
                this.logger.debug('LOGIN', 'Network idle timeout after sign in, checking page state...')
            }

            await this.utils.wait(this.utils.randomDelay(2000, 3000))

            // 4. Handle hurdles (Stay signed in, 2FA, etc.)
            await this.handlePostLoginHurdles(page)

            // Final check
            if (await this.isLoggedIn(page)) {
                this.logger.info('LOGIN', `Login successful: ${account.email}`)
            } else {
                const url = page.url()
                if (url.includes('account.microsoft.com') || url.includes('rewards.bing.com')) {
                    this.logger.info('LOGIN', `Login likely successful (on ${url}): ${account.email}`)
                } else {
                    this.logger.warn('LOGIN', `Login completed but final state is uncertain: ${url}`)
                }
            }
        } catch (error) {
            this.logger.error('LOGIN', `Login failed: ${account.email}`, { error: error instanceof Error ? error.message : String(error) })
            // Take a screenshot on failure for debugging if headed
            await page.screenshot({ path: `logs/login_failure_${account.email.replace(/@/, '_')}.png` }).catch(() => { })
            throw new Error(`Login failed for ${account.email}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    /**
     * Handle "Stay signed in?", "Break free from passwords", etc.
     */
    private async handlePostLoginHurdles(page: Page): Promise<void> {
        this.logger.debug('LOGIN', 'Checking for post-login hurdles...')

        // 1. "Stay signed in?" prompt
        try {
            // This prompt often has id="KmsiDescription" or similar
            const staySignedInSelector = '#idSIButton9, input[type="submit"], #idBtn_Back'
            const button = await page.waitForSelector(staySignedInSelector, { timeout: 8000 })
            if (button) {
                this.logger.debug('LOGIN', 'Handling post-login prompt (Stay signed in or similar)')
                await button.click()
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { })
            }
        } catch {
            this.logger.debug('LOGIN', 'No "Stay signed in" prompt detected via selector')
        }

        // 2. Navigation to dashboard check
        if (page.url().includes('rewards.bing.com') || page.url().includes('account.microsoft.com')) {
            return
        }

        // Sometimes it stops at a different page, just try to move on
        await this.utils.wait(2000)
    }

    /**
     * Click the primary Microsoft action button (usually idSIButton9)
     */
    private async clickPrimaryButton(page: Page, label: string): Promise<void> {
        this.logger.debug('LOGIN', `Clicking ${label} button`)

        // Microsoft uses this ID for almost all primary actions in login flow
        const primaryButtonId = '#idSIButton9'
        const fallbackSelector = 'input[type="submit"], button[type="submit"]'

        try {
            const btn = await page.waitForSelector(`${primaryButtonId}, ${fallbackSelector}`, { timeout: 10000 })
            await btn.click()
        } catch (error) {
            this.logger.warn('LOGIN', `Primary button (${label}) not found: ${error instanceof Error ? error.message : String(error)}`)
            // Try to find ANY submit button as last resort
            const anySubmit = await page.$('input[type="submit"]')
            if (anySubmit) {
                await anySubmit.click()
            } else {
                throw new Error(`Could not find ${label} button`)
            }
        }
    }

    /**
     * Handle common security or verification prompts
     */
    private async handleSecurityPrompts(page: Page): Promise<void> {
        const url = page.url()
        if (url.includes('identity/confirm') || url.includes('Abuse?')) {
            this.logger.critical('LOGIN', 'Account requires manual verification or is locked!', { url })
            throw new Error('Manual verification required')
        }

        // "Break free from passwords" (Microsoft Authenticator ad)
        try {
            const skipLink = await page.$('#iShowSkip')
            if (skipLink) {
                this.logger.debug('LOGIN', 'Skipping Microsoft Authenticator prompt')
                await skipLink.click()
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { })
            }
        } catch { }
    }

    /**
     * Check if page is a post-login destination
     */
    private async isAtHomeOrDashboard(page: Page): Promise<boolean> {
        const url = page.url()
        return url.includes('account.microsoft.com') || url.includes('rewards.bing.com') || url.includes('bing.com/search')
    }

    /**
     * Check if already logged in
     */
    async isLoggedIn(page: Page): Promise<boolean> {
        try {
            // If we're already on a dashboard-like page, we're likely logged in
            if (await this.isAtHomeOrDashboard(page)) {
                // Double check for generic sign-in links that might still be there but authenticated
                const loginLink = await page.$('a:has-text("Sign in")').catch(() => null)
                if (!loginLink) return true
            }

            // Check current page for user profile indicators
            const hasRewardsPopover = await page.$('[data-bi-id="rewardspopover"]').catch(() => null)
            if (hasRewardsPopover) return true

            // Navigate to dashboard if not there
            if (!page.url().includes('rewards.bing.com/dashboard')) {
                await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 })
            }

            if (page.url().includes('login.live.com')) {
                return false
            }

            const pointsIndicator = await page.$('.pointsValue, #sb_rewards_points').catch(() => null)
            return pointsIndicator !== null
        } catch {
            return false
        }
    }

    /**
     * Type text with human-like delays between keystrokes
     */
    private async typeHumanLike(element: ElementHandle, text: string): Promise<void> {
        for (const char of text) {
            await element.type(char)
            // Random delay between 50-150ms per keystroke
            await this.utils.wait(this.utils.randomDelay(50, 150))
        }
    }
}
