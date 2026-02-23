
import type { Page } from 'patchright'
import { Logger } from '../../logging/Logger'
import { AiService } from '../AiService'

export class VisualActivityHandler {
    private logger: Logger
    private aiService?: AiService

    constructor(logger: Logger, aiService?: AiService) {
        this.logger = logger
        this.aiService = aiService
    }

    /**
     * visually click a dashboard card based on its offerId.
     * This is a fallback for when API methods fail or for unsupported types like Polls.
     */
    async execute(page: Page, offerId: string, title: string): Promise<boolean> {
        this.logger.info('VISUAL-ACTIVITY', `Attempting visual activity execution for "${title}" (offerId=${offerId})`)

        try {
            // Setup listener for new tabs (common for Rewards activities)
            const pagePromise = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null)

            // Strategy 1: Standard Playwright selectors (fastest)
            let clicked = false
            const selectors = [
                `[data-bi-id^="${offerId}"] .pointLink:not(.contentContainer .pointLink)`,
                `[data-bi-id="${offerId}"] .pointLink:not(.contentContainer .pointLink)`,
                `[data-bi-id^="${offerId}"] .pointLink`,
                `a[data-bi-id^="${offerId}"]`,
                `div[data-offer-id="${offerId}"]`,
                `a[href*="${offerId}"]`,
                `div[class*="promotional-item"] a[href*="${offerId}"]`,
                `a:has-text("${title}")`,
                `[aria-label*="${title}"]`,
                `[title*="${title}"]`
            ]

            for (const selector of selectors) {
                try {
                    const el = page.locator(selector).first()
                    if (await el.count() > 0) {
                        this.logger.debug('VISUAL-ACTIVITY', `Found element via selector: ${selector}`)
                        await el.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => { })
                        await el.click({ force: true, timeout: 2000 }).catch(() => { })
                        clicked = true
                        break
                    }
                } catch { /* try next */ }
            }

            // Strategy 2: Aggressive DOM-wide search
            if (!clicked) {
                this.logger.debug('VISUAL-ACTIVITY', 'Standard selectors failed. Starting aggressive DOM scan...')
                clicked = await page.evaluate(({ id, t }) => {
                    function findMatchingElement(root: Node): HTMLElement | null {
                        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
                        let node = walker.nextNode() as HTMLElement | null

                        while (node) {
                            const href = String((node as any).href || '')
                            const text = (node.innerText || node.textContent || '').toLowerCase()
                            const ariaLabel = node.getAttribute('aria-label')?.toLowerCase() || ''
                            const dataId = node.getAttribute('data-bi-id') || node.getAttribute('data-offer-id') || ''

                            if (dataId.includes(id) || href.includes(id) || text.includes(t.toLowerCase()) || ariaLabel.includes(t.toLowerCase())) {
                                if (node.tagName === 'A' || node.tagName === 'BUTTON' || node.onclick || node.getAttribute('role') === 'button') {
                                    return node
                                }
                            }

                            if (node.shadowRoot) {
                                const found = findMatchingElement(node.shadowRoot)
                                if (found) return found
                            }
                            node = walker.nextNode() as HTMLElement | null
                        }
                        return null
                    }

                    const target = findMatchingElement(document.body)
                    if (target) {
                        target.scrollIntoView()
                        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                        target.click()
                        return true
                    }
                    return false
                }, { id: offerId, t: title })
            }

            // Strategy 3: Section-based fallback
            if (!clicked) {
                const sectionSelector = title.toLowerCase().includes('daily') ? 'section#dailyset' : 'section'
                this.logger.debug('VISUAL-ACTIVITY', `Falling back to section-based search (${sectionSelector})...`)

                clicked = await page.evaluate(({ sel, t }) => {
                    const section = document.querySelector(sel)
                    if (!section) return false
                    const links = Array.from(section.querySelectorAll('a, [role="button"]'))
                    const match = links.find(l => ((l as HTMLElement).innerText || l.textContent || '').toLowerCase().includes(t.toLowerCase()))
                    if (match) {
                        (match as HTMLElement).click()
                        return true
                    }
                    if (sel.includes('dailyset')) {
                        const firstLink = section.querySelector('a')
                        if (firstLink) {
                            (firstLink as HTMLElement).click()
                            return true
                        }
                    }
                    return false
                }, { sel: sectionSelector, t: title })
            }

            if (clicked) {
                const newPage = await pagePromise
                if (newPage) {
                    this.logger.info('VISUAL-ACTIVITY', 'Activity tab opened, waiting for load...')
                    await newPage.waitForLoadState('domcontentloaded').catch(() => { })
                    await page.waitForTimeout(5000) // Wait for reward to register

                    if (title.toLowerCase().includes('poll') || title.toLowerCase().includes('quiz')) {
                        await this.handlePoll(newPage)
                    }

                    await newPage.close().catch(() => { })
                    this.logger.info('VISUAL-ACTIVITY', 'Closed activity tab')
                } else {
                    this.logger.debug('VISUAL-ACTIVITY', 'No new tab detected, assuming inline or background click.')
                    await page.waitForTimeout(2000)
                }
                return true
            }

            // Failure
            this.logger.warn('VISUAL-ACTIVITY', `All visual strategies failed for "${title}"`)
            return false

        } catch (error) {
            this.logger.error('VISUAL-ACTIVITY', `Error in visual execution: ${error instanceof Error ? error.message : String(error)}`)
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

            // AI Fallback for Polls
            if (this.aiService) {
                this.logger.debug('VISUAL-ACTIVITY', 'Poll automation failed, trying AI fallback...')
                const pageText = await page.evaluate(() => document.body.innerText.substring(0, 3000))
                const aiResult = await this.aiService.findElement(pageText, 'Find the first available option in this poll and provide a CSS selector to click it.')

                if (aiResult?.selector && aiResult.confidence > 0.6) {
                    this.logger.info('VISUAL-ACTIVITY', `AI suggested poll selector: ${aiResult.selector}`)
                    try {
                        await page.click(aiResult.selector, { timeout: 5000, force: true })
                        return
                    } catch (err) {
                        this.logger.warn('VISUAL-ACTIVITY', `AI recommended poll selector failed: ${aiResult.selector}`)
                    }
                }
            }

            this.logger.warn('VISUAL-ACTIVITY', 'Failed to interact with poll options')
        } catch (e) {
            this.logger.warn('VISUAL-ACTIVITY', `Error in poll handler: ${e instanceof Error ? e.message : String(e)}`)
        }
    }
}
