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

    // ══════════════════════════════════════════════════════════════════════════
    // ELEMENT DISCOVERY
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Resiliently find an element using multiple strategies.
     */
    async discoverElement(
        page: Page,
        description: {
            selectors?: string[]
            text?: string[]
            role?: string
            aiGoal?: string
        }
    ): Promise<DiscoveryResult> {
        this.logger.debug('UI-SERVICE', `Discovering: ${JSON.stringify(description)}`)

        // ── 1. Standard CSS/attribute selectors ────────────────────────────
        if (description.selectors) {
            for (const selector of description.selectors) {
                try {
                    const el = await page.$(selector)
                    if (el && await el.isVisible().catch(() => false)) {
                        return { element: el, strategy: `selector:${selector}`, confidence: 1.0 }
                    }
                } catch { /* next */ }
            }
        }

        // ── 2. Text / aria-label matching ──────────────────────────────────
        if (description.text) {
            for (const t of description.text) {
                const candidates = [
                    `text="${t}"`,
                    `[aria-label*="${t}" i]`,
                    `button:has-text("${t}")`,
                    `[role="button"]:has-text("${t}")`,
                ]
                for (const sel of candidates) {
                    try {
                        const el = await page.$(sel)
                        if (el && await el.isVisible().catch(() => false)) {
                            return { element: el, strategy: `text:${t}`, confidence: 0.9 }
                        }
                    } catch { /* next */ }
                }
            }
        }

        // ── 3. Shadow DOM + heuristic scan ────────────────────────────────
        const heuristicId = await page.evaluate((desc) => {
            function findResilient(root: ParentNode = document): string | null {
                const buttons = Array.from(
                    root.querySelectorAll<HTMLElement>('button, [role="button"]')
                )

                for (const btn of buttons) {
                    const btnText = (btn.innerText ?? '').toLowerCase()
                    const ariaLabel = (btn.getAttribute('aria-label') ?? '').toLowerCase()

                    const matchesText = desc.text?.some(
                        (t: string) =>
                            btnText.includes(t.toLowerCase()) ||
                            ariaLabel.includes(t.toLowerCase())
                    )

                    if (matchesText) {
                        if (!btn.id) btn.id = `ui-resilient-${Math.random().toString(36).substr(2, 9)}`
                        return btn.id
                    }

                    // Toggle heuristic: small button with SVG near matching text
                    if (desc.role === 'toggle') {
                        const hasSvg  = btn.querySelector('svg') !== null
                        const isSmall = btn.offsetWidth < 70 && btn.offsetHeight < 70
                        if (hasSvg && isSmall) {
                            let parent = btn.parentElement
                            for (let i = 0; i < 5 && parent; i++) {
                                const parentText = (parent.innerText ?? '').toLowerCase()
                                if (desc.text?.some((t: string) => parentText.includes(t.toLowerCase()))) {
                                    if (!btn.id) btn.id = `ui-toggle-${Math.random().toString(36).substr(2, 9)}`
                                    return btn.id
                                }
                                parent = parent.parentElement
                            }
                        }
                    }
                }

                // Recurse into shadow roots
                for (const node of Array.from(root.querySelectorAll('*'))) {
                    if ((node as Element).shadowRoot) {
                        const found = findResilient((node as Element).shadowRoot!)
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

        // ── 4. AI fallback ─────────────────────────────────────────────────
        if (this.aiService && description.aiGoal) {
            this.logger.debug('UI-SERVICE', 'Triggering AI fallback...')
            const pageText = await page.evaluate(() =>
                document.body.innerText.substring(0, 4000)
            )
            const aiResult = await this.aiService.findElement(pageText, description.aiGoal)

            if (aiResult?.selector && aiResult.confidence > 0.6) {
                const el = await page.$(aiResult.selector).catch(() => null)
                if (el) {
                    this.logger.info('UI-SERVICE', `AI found element: ${aiResult.selector}`)
                    return { element: el, strategy: `ai:${aiResult.selector}`, confidence: aiResult.confidence }
                }
            }
        }

        return { element: null, strategy: 'none', confidence: 0 }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // RESILIENT CLICK
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Resiliently find and click an element.
     *
     * FIX: The old version checked aria-expanded="true" and skipped — this broke
     * task card clicks (cards are not disclosure buttons). Now we only skip if the
     * element is specifically a disclosure trigger (slot="trigger") AND already open.
     */
    async clickResiliently(
        page: Page,
        description: {
            selectors?: string[]
            text?: string[]
            role?: string
            aiGoal?: string
        }
    ): Promise<boolean> {
        const result = await this.discoverElement(page, description)

        if (!result.element) return false

        try {
            // Only skip the click if this is specifically a disclosure trigger
            // that is ALREADY expanded. Never skip task card links.
            const isDisclosureTrigger = await result.element
                .getAttribute('slot')
                .then(s => s === 'trigger')
                .catch(() => false)

            if (isDisclosureTrigger) {
                const isExpanded = await result.element
                    .getAttribute('aria-expanded')
                    .catch(() => null)

                if (isExpanded === 'true') {
                    this.logger.debug('UI-SERVICE', `Disclosure trigger already expanded, skipping click`)
                    return true // treat as success — section is open
                }
            }

            await result.element.scrollIntoViewIfNeeded().catch(() => { })
            await result.element.click({ force: true, timeout: 5000 })
            this.logger.debug('UI-SERVICE', `Clicked via strategy: ${result.strategy}`)
            return true
        } catch (err) {
            this.logger.warn('UI-SERVICE', `Click failed (${result.strategy}): ${err instanceof Error ? err.message : String(err)}`)

            // Last-resort: DOM evaluate click
            try {
                const clicked = await result.element.evaluate((el: HTMLElement) => {
                    el.scrollIntoView({ block: 'center' })
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                    el.click()
                    return true
                })
                if (clicked) {
                    this.logger.debug('UI-SERVICE', `DOM evaluate fallback click succeeded`)
                    return true
                }
            } catch { /* give up */ }

            return false
        }
    }
}