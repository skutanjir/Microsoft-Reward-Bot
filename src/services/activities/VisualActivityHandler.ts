
import type { Page } from 'patchright'
import { Logger } from '../../logging/Logger'

export class VisualActivityHandler {
    private logger: Logger

    constructor(logger: Logger) {
        this.logger = logger
    }

    /**
     * visually click a dashboard card based on its offerId.
     * This is a fallback for when API methods fail or for unsupported types like Polls.
     */
    async execute(page: Page, offerId: string, title: string, activityName?: string): Promise<boolean> {
        this.logger.info('VISUAL-ACTIVITY', `Attempting visual click for "${title}" (offerId=${offerId}) on URL: ${page.url()}`)

        try {
            // Diagnostic: Take a screenshot if we fail
            const takeScreenshot = async (screenshotName: string) => {
                const path = `./logs/visual_fail_${screenshotName}_${Date.now()}.png`
                await page.screenshot({ path }).catch(() => { })
                this.logger.debug('VISUAL-ACTIVITY', `Screenshot saved to: ${path}`)
            }

            // Build selector list — supports both old UI (pointLink) and new UI (data attributes)
            const name = activityName?.toLowerCase() ?? ''

            const selectors = [
                // === Old UI selectors (TheNetsky pattern) ===
                // :not(.contentContainer .pointLink) avoids clicking nested content links
                `[data-bi-id^="${offerId}"] .pointLink:not(.contentContainer .pointLink)`,
                `[data-bi-id="${offerId}"] .pointLink:not(.contentContainer .pointLink)`,
                // Name-based selectors for special activities (membercenter, exploreonbing)
                ...(name ? [`[data-bi-id^="${name}"] .pointLink:not(.contentContainer .pointLink)`] : []),
                // Broader old UI fallbacks
                `[data-bi-id^="${offerId}"] .pointLink`,
                `a[data-bi-id^="${offerId}"]`,
                // === New UI selectors ===
                `div[data-offer-id="${offerId}"]`,
                `a[href*="${offerId}"]`,
                `div[class*="promotional-item"] a[href*="${offerId}"]`,
                // === Text-based fallbacks (last resort) ===
                `button:has-text("${title}")`,
                `a:has-text("${title}")`,
                `[aria-label*="${title}"]`,
                `[title*="${title}"]`
            ]

            let targetElement = null
            for (const selector of selectors) {
                try {
                    const el = page.locator(selector).first()
                    if (await el.count() > 0) {
                        targetElement = el
                        this.logger.debug('VISUAL-ACTIVITY', `Found element with selector: ${selector}`)
                        break
                    }
                } catch { }
            }

            if (!targetElement) {
                this.logger.warn('VISUAL-ACTIVITY', `Could not find element for "${title}" (offerId=${offerId}). Checking page for similar patterns...`)
                await takeScreenshot(offerId)

                // Diagnostic: Check for all elements, piercing Shadow DOM
                const diagnosticInfo = await page.evaluate(() => {
                    const results: any[] = []
                    const scan = (root: any, depth: number) => {
                        if (!root || !root.querySelectorAll || depth > 5) return

                        // Look for all links and potential interactive elements
                        const elements = root.querySelectorAll('a, button, [data-offer-id], [data-bi-id], [class*="promotional"]')
                        elements.forEach((el: any) => {
                            const attrs: any = {}
                            for (const attr of el.attributes) {
                                if (attr.name.startsWith('data-') || attr.name === 'href' || attr.name === 'class') {
                                    attrs[attr.name] = attr.value.substring(0, 50)
                                }
                            }
                            results.push({
                                tag: el.tagName,
                                text: el.textContent?.substring(0, 30).trim(),
                                attrs
                            })
                        })

                        // Recursive Shadow DOM scan
                        root.querySelectorAll('*').forEach((el: any) => {
                            if (el.shadowRoot) scan(el.shadowRoot, depth + 1)
                        })
                    }

                    scan(document, 0)
                    return results.slice(0, 50)
                })
                this.logger.debug('VISUAL-ACTIVITY', `Extensive DOM Scan: ${JSON.stringify(diagnosticInfo)}`)

                return false
            }

            // Click handling - anticipate a new tab opening
            this.logger.info('VISUAL-ACTIVITY', `Clicking "${title}"...`)

            // Interaction: scroll, hover, then click
            await targetElement.scrollIntoViewIfNeeded()
            await page.waitForTimeout(500)
            await targetElement.hover().catch(() => { })

            const [newPage] = await Promise.all([
                page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
                targetElement.click({ force: true }).catch(async () => {
                    this.logger.debug('VISUAL-ACTIVITY', 'Standard click failed, trying dispatchEvent("click")')
                    await targetElement.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })))
                })
            ])

            if (newPage) {
                this.logger.info('VISUAL-ACTIVITY', 'New tab opened, waiting for load...')
                await newPage.waitForLoadState('domcontentloaded').catch(() => { })
                await newPage.waitForTimeout(8000) // Increased wait for "counting"

                // If it's a poll, we might need to click an answer
                if (title.toLowerCase().includes('poll') || title.toLowerCase().includes('quiz')) {
                    this.logger.info('VISUAL-ACTIVITY', 'Poll/Quiz detected in tab, checking for options...')
                    await this.handlePoll(newPage)
                }

                await newPage.close().catch(() => { })
                this.logger.info('VISUAL-ACTIVITY', 'Closed activity tab')
                return true
            } else {
                this.logger.info('VISUAL-ACTIVITY', 'No new tab detected (might be inline or failed)')
                await page.waitForTimeout(2000)
                return true
            }

        } catch (error) {
            this.logger.error('VISUAL-ACTIVITY', `Error performing visual click: ${error instanceof Error ? error.message : String(error)}`)
            return false
        }
    }

    private async handlePoll(page: Page): Promise<void> {
        try {
            // Generic poll option selectors
            const optionSelectors = [
                '.btOption',
                '.wk_OptionClick',
                'div[role="radio"]',
                '.poll-option'
            ]

            for (const selector of optionSelectors) {
                const options = await page.$$(selector)
                if (options.length > 0) {
                    await options[0].click()
                    this.logger.info('VISUAL-ACTIVITY', 'Clicked poll option')
                    await page.waitForTimeout(3000)
                    return
                }
            }
        } catch (e) {
            this.logger.warn('VISUAL-ACTIVITY', 'Failed to interact with poll options')
        }
    }
}
