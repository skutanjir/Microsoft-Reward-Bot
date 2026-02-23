import type { Page, ElementHandle } from 'patchright'
import { Logger } from '../logging/Logger'
import { AiService } from './AiService'

export interface DiscoveryResult {
    element: ElementHandle | null
    strategy: string
    confidence: number
}

export class UIService {
    private logger: Logger
    private aiService?: AiService

    constructor(logger: Logger, aiService?: AiService) {
        this.logger = logger
        this.aiService = aiService
    }

    /**
     * Resiliently find an element using multiple strategies
     */
    async discoverElement(page: Page, description: {
        selectors?: string[],
        text?: string[],
        role?: string,
        aiGoal?: string
    }): Promise<DiscoveryResult> {
        this.logger.debug('UI-SERVICE', `Discovering element: ${JSON.stringify(description)}`)

        // 1. Try standard selectors
        if (description.selectors) {
            for (const selector of description.selectors) {
                const el = await page.$(selector).catch(() => null)
                if (el && await el.isVisible()) {
                    return { element: el, strategy: `selector:${selector}`, confidence: 1.0 }
                }
            }
        }

        // 2. Try text/label identification
        if (description.text) {
            for (const t of description.text) {
                const el = await page.$(`text="${t}"`).catch(() => null)
                    || await page.$(`[aria-label*="${t}" i]`).catch(() => null)
                    || await page.$(`button:has-text("${t}")`).catch(() => null)

                if (el && await el.isVisible()) {
                    return { element: el, strategy: `text:${t}`, confidence: 0.9 }
                }
            }
        }

        // 3. Shadow DOM & Heuristic scan
        const heuristicId = await page.evaluate((desc) => {
            function findResilient(root: ParentNode = document): string | null {
                // Heuristic: Check for small buttons with SVG and labels
                const buttons = Array.from(root.querySelectorAll('button, [role="button"]')) as HTMLElement[]

                for (const btn of buttons) {
                    const btnText = btn.innerText.toLowerCase()
                    const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || ''
                    const matchesText = desc.text?.some((t: string) => btnText.includes(t.toLowerCase()) || ariaLabel.includes(t.toLowerCase()))

                    if (matchesText) {
                        if (!btn.id) btn.id = `ui-resilient-${Math.random().toString(36).substr(2, 9)}`
                        return btn.id
                    }

                    // Special case for chevrons/toggles: tiny button with SVG
                    if (desc.role === 'toggle') {
                        const hasSvg = btn.querySelector('svg') !== null
                        const isSmall = btn.offsetWidth < 70 && btn.offsetHeight < 70
                        if (hasSvg && isSmall) {
                            // Check ancestors for context
                            let parent = btn.parentElement
                            for (let i = 0; i < 5 && parent; i++) {
                                const parentText = parent.innerText.toLowerCase()
                                if (desc.text?.some((t: string) => parentText.includes(t.toLowerCase()))) {
                                    if (!btn.id) btn.id = `ui-toggle-${Math.random().toString(36).substr(2, 9)}`
                                    return btn.id
                                }
                                parent = parent.parentElement
                            }
                        }
                    }
                }

                // Recurse into Shadow DOM
                const all = root.querySelectorAll('*')
                for (const node of Array.from(all)) {
                    if (node.shadowRoot) {
                        const found = findResilient(node.shadowRoot)
                        if (found) return found
                    }
                }
                return null
            }
            return findResilient()
        }, description)

        if (heuristicId) {
            const el = await page.$(`#${heuristicId}`)
            if (el) return { element: el, strategy: 'heuristic', confidence: 0.8 }
        }

        // 4. AI Fallback
        if (this.aiService && description.aiGoal) {
            this.logger.debug('UI-SERVICE', 'Triggering AI fallback for element discovery...')
            const pageText = await page.evaluate(() => document.body.innerText.substring(0, 4000))
            const aiResult = await this.aiService.findElement(pageText, description.aiGoal)

            if (aiResult?.selector && aiResult.confidence > 0.6) {
                const el = await page.$(aiResult.selector).catch(() => null)
                if (el) {
                    this.logger.info('UI-SERVICE', `AI successfully discovered element: ${aiResult.selector}`)
                    return { element: el, strategy: `ai:${aiResult.selector}`, confidence: aiResult.confidence }
                }
            }
        }

        return { element: null, strategy: 'none', confidence: 0 }
    }

    /**
     * Resiliently click an element discovered via UIService
     */
    async clickResiliently(page: Page, description: {
        selectors?: string[],
        text?: string[],
        role?: string,
        aiGoal?: string
    }): Promise<boolean> {
        const result = await this.discoverElement(page, description)
        if (result.element) {
            try {
                // Check if element is already expanded to avoid re-collapsing
                const isExpanded = await result.element.getAttribute('aria-expanded')
                if (isExpanded === 'true') {
                    this.logger.debug('UI-SERVICE', `Element is already expanded (aria-expanded: true). Skipping click.`)
                    return true
                }

                await result.element.click({ force: true, timeout: 5000 })
                return true
            } catch (err) {
                this.logger.warn('UI-SERVICE', `Failed to click element found via ${result.strategy}`)
            }
        }
        return false
    }
}
