/**
 * Visual Activity Handler
 * Clicks reward activity cards on the Microsoft Rewards dashboard.
 *
 * Strategy cascade (fastest → most robust):
 *  1. Direct CSS by offerId attributes
 *  2. Direct CSS by title text via :has()
 *  3. page.locator Playwright-native (handles shadow DOM, retries)
 *  4. Aggressive DOM TreeWalker (finds anything clickable)
 *  5. Section-scoped fallback
 *  6. AI fallback (if AiService available)
 */

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

    // ══════════════════════════════════════════════════════════════════════════
    // MAIN ENTRY
    // ══════════════════════════════════════════════════════════════════════════

    async execute(page: Page, offerId: string, title: string): Promise<boolean> {
        this.logger.info('VISUAL', `Executing visual click | offerId=${offerId} | title="${title}"`)

        // Set up new-tab listener before any click attempt
        const newPagePromise = page.context()
            .waitForEvent('page', { timeout: 10000 })
            .catch(() => null)

        const clicked = await this.tryAllClickStrategies(page, offerId, title)

        if (!clicked) {
            this.logger.warn('VISUAL', `All click strategies failed for "${title}"`)
            return false
        }

        // Handle resulting page (new tab or same-tab nav)
        await this.handlePostClick(page, newPagePromise, title)
        return true
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CLICK STRATEGIES
    // ══════════════════════════════════════════════════════════════════════════

    private async tryAllClickStrategies(page: Page, offerId: string, title: string): Promise<boolean> {

        // ── Strategy 1: data-bi-id attribute selectors ─────────────────────
        // MS Rewards uses data-bi-id on card wrappers, inner .pointLink anchors,
        // or data-offer-id. Try all variants.
        const biIdSelectors = [
            // New UI: the anchor tag itself carries data-bi-id
            `a[data-bi-id="${offerId}"]`,
            `a[data-bi-id*="${offerId}"]`,
            // Legacy: wrapper div with pointLink inside
            `[data-bi-id="${offerId}"] .pointLink`,
            `[data-bi-id*="${offerId}"] .pointLink`,
            // data-offer-id
            `[data-offer-id="${offerId}"]`,
            `a[data-offer-id="${offerId}"]`,
            // href contains offerId
            `a[href*="${offerId}"]`,
        ]

        for (const sel of biIdSelectors) {
            const result = await this.clickWithLocator(page, sel, `biId:${sel}`)
            if (result) return true
        }

        // ── Strategy 2: Locator by title text (Playwright-native, most reliable) ──
        const titleStrategies = [
            // Exact accessible name
            page.getByRole('link', { name: title, exact: false }),
            page.getByRole('button', { name: title, exact: false }),
            // Text content match
            page.locator(`a`).filter({ hasText: title }),
            page.locator(`[role="button"]`).filter({ hasText: title }),
            // aria-label partial match
            page.locator(`[aria-label*="${title}" i]`),
        ]

        for (const loc of titleStrategies) {
            try {
                const count = await loc.count()
                if (count > 0) {
                    const el = loc.first()
                    const isVisible = await el.isVisible().catch(() => false)
                    if (!isVisible) continue

                    this.logger.debug('VISUAL', `Strategy 2 (locator) found element for "${title}"`)
                    await el.scrollIntoViewIfNeeded().catch(() => { })
                    await el.click({ force: true, timeout: 5000 })
                    return true
                }
            } catch { /* try next */ }
        }

        // ── Strategy 3: CSS by partial title in text content ───────────────
        const cssTextSelectors = [
            `a:has([class*="title"]):has-text("${this.escapeForCSS(title)}")`,
            `a:has(p):has-text("${this.escapeForCSS(title)}")`,
            `[title="${title}"]`,
            `[title*="${title}"]`,
        ]

        for (const sel of cssTextSelectors) {
            const result = await this.clickWithLocator(page, sel, `cssText:${sel}`)
            if (result) return true
        }

        // ── Strategy 4: Aggressive DOM TreeWalker scan ─────────────────────
        const domClicked = await this.aggressiveDOMClick(page, offerId, title)
        if (domClicked) return true

        // ── Strategy 5: Section-scoped fallback ───────────────────────────
        const sectionClicked = await this.sectionScopedClick(page, title)
        if (sectionClicked) return true

        // ── Strategy 6: AI fallback ────────────────────────────────────────
        if (this.aiService) {
            const aiClicked = await this.aiClick(page, title)
            if (aiClicked) return true
        }

        return false
    }

    // ── Helper: click via CSS selector using Playwright locator ──────────────
    private async clickWithLocator(page: Page, selector: string, strategyName: string): Promise<boolean> {
        try {
            const loc = page.locator(selector).first()
            const count = await loc.count()
            if (count === 0) return false

            const isVisible = await loc.isVisible().catch(() => false)
            if (!isVisible) return false

            this.logger.debug('VISUAL', `${strategyName} — found element, clicking`)
            await loc.scrollIntoViewIfNeeded().catch(() => { })
            await loc.click({ force: true, timeout: 5000 })
            return true
        } catch (e) {
            this.logger.debug('VISUAL', `${strategyName} failed: ${e instanceof Error ? e.message : String(e)}`)
            return false
        }
    }

    // ── Strategy 4: DOM TreeWalker — walks entire DOM including shadow roots ─
    private async aggressiveDOMClick(page: Page, offerId: string, title: string): Promise<boolean> {
        this.logger.debug('VISUAL', `Strategy 4 (DOM scan) for "${title}"`)

        return page.evaluate(({ id, t }) => {
            function walkNode(root: Node): HTMLElement | null {
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
                let node = walker.nextNode() as HTMLElement | null

                while (node) {
                    const el = node as HTMLElement
                    const tag = el.tagName

                    // Only consider clickable elements
                    if (tag === 'A' || tag === 'BUTTON' || el.getAttribute('role') === 'button' || el.onclick) {
                        const href = (el as HTMLAnchorElement).href ?? ''
                        const text = (el.innerText ?? el.textContent ?? '').trim()
                        const ariaLabel = el.getAttribute('aria-label') ?? ''
                        const dataId = el.getAttribute('data-bi-id') ?? el.getAttribute('data-offer-id') ?? ''

                        const matchesId = id && (dataId.includes(id) || href.includes(id))
                        const matchesTitle = t && (
                            text.toLowerCase().includes(t.toLowerCase()) ||
                            ariaLabel.toLowerCase().includes(t.toLowerCase())
                        )

                        if (matchesId || matchesTitle) {
                            return el
                        }
                    }

                    // Recurse into shadow DOM
                    if ((node as Element).shadowRoot) {
                        const found = walkNode((node as Element).shadowRoot!)
                        if (found) return found
                    }

                    node = walker.nextNode() as HTMLElement | null
                }
                return null
            }

            const target = walkNode(document.body)
            if (!target) return false

            target.scrollIntoView({ behavior: 'smooth', block: 'center' })

            // Try multiple click methods
            target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
            target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
            target.click()
            return true
        }, { id: offerId, t: title })
    }

    // ── Strategy 5: Section-scoped click ────────────────────────────────────
    private async sectionScopedClick(page: Page, title: string): Promise<boolean> {
        this.logger.debug('VISUAL', `Strategy 5 (section-scoped) for "${title}"`)

        const isDailySet = title.toLowerCase().includes('daily')
        const sectionSelector = isDailySet ? 'section#dailyset, [aria-label*="Daily set" i]' : '[aria-label*="Keep earning" i], [aria-label*="More activities" i], main'

        return page.evaluate(({ sel, t, ds }) => {
            const sections = Array.from(document.querySelectorAll<HTMLElement>(sel))
            const searchScope: HTMLElement = sections.length > 0 ? sections[0] : document.body

            // Find any anchor or button whose text matches
            const clickable = Array.from(searchScope.querySelectorAll<HTMLElement>('a, button, [role="button"]'))
            const match = clickable.find(el =>
                (el.innerText ?? el.textContent ?? '').toLowerCase().includes(t.toLowerCase()) ||
                (el.getAttribute('aria-label') ?? '').toLowerCase().includes(t.toLowerCase())
            )

            if (!match) {
                // Last-ditch: click first uncompleted card in section
                const firstLink = searchScope.querySelector<HTMLElement>('a[href]:not([aria-disabled="true"])')
                if (firstLink && ds) {
                    firstLink.click()
                    return true
                }
                return false
            }

            match.scrollIntoView({ block: 'center' })
            match.click()
            return true
        }, { sel: sectionSelector, t: title, ds: isDailySet })
    }

    // ── Strategy 6: AI fallback ──────────────────────────────────────────────
    private async aiClick(page: Page, title: string): Promise<boolean> {
        if (!this.aiService) return false
        this.logger.debug('VISUAL', `Strategy 6 (AI) for "${title}"`)

        try {
            const pageText = await page.evaluate(() => document.body.innerText.substring(0, 4000))
            const aiResult = await this.aiService.findElement(
                pageText,
                `Find a clickable link or button for the Microsoft Rewards activity titled "${title}". Return a CSS selector.`
            )

            if (aiResult?.selector && aiResult.confidence > 0.6) {
                this.logger.info('VISUAL', `AI suggested selector: ${aiResult.selector}`)
                return await this.clickWithLocator(page, aiResult.selector, 'ai')
            }
        } catch (e) {
            this.logger.warn('VISUAL', `AI strategy error: ${e instanceof Error ? e.message : String(e)}`)
        }
        return false
    }

    // ══════════════════════════════════════════════════════════════════════════
    // POST-CLICK HANDLER
    // ══════════════════════════════════════════════════════════════════════════

    private async handlePostClick(
        page: Page,
        newPagePromise: Promise<any>,
        title: string
    ): Promise<void> {
        this.logger.debug('VISUAL', `Waiting for post-click result for "${title}"`)

        const newPage = await newPagePromise

        if (newPage) {
            this.logger.info('VISUAL', `New tab opened for "${title}", waiting...`)
            await newPage.waitForLoadState('domcontentloaded').catch(() => { })

            // Wait longer to ensure reward registers server-side
            await new Promise(r => setTimeout(r, 5000))

            // Handle quiz/poll on new tab
            const url = newPage.url()
            if (url.includes('pollscenarioid') || url.includes('quiz') || title.toLowerCase().includes('poll')) {
                await this.handlePoll(newPage)
            }

            await newPage.close().catch(() => { })
            this.logger.info('VISUAL', `Closed activity tab for "${title}"`)
        } else {
            // Same-tab navigation
            const currentUrl = page.url()
            this.logger.debug('VISUAL', `No new tab detected (current: ${currentUrl}), waiting 3s`)
            await new Promise(r => setTimeout(r, 3000))
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // POLL HANDLER
    // ══════════════════════════════════════════════════════════════════════════

    private async handlePoll(page: Page): Promise<void> {
        this.logger.info('VISUAL', 'Handling poll/quiz page...')

        // Wait for page to fully load
        await page.waitForLoadState('domcontentloaded').catch(() => { })
        await new Promise(r => setTimeout(r, 2000))

        const optionSelectors = [
            '.btOption',
            '.wk_OptionClick',
            'div[role="radio"]',
            'input[type="radio"]',
            '.poll-option',
            '[class*="option"]',
            '[class*="answer"]',
            '[class*="choice"]',
        ]

        for (const sel of optionSelectors) {
            try {
                const options = await page.$$(sel)
                if (options.length > 0) {
                    this.logger.info('VISUAL', `Clicking poll option via: ${sel}`)
                    await options[0].scrollIntoViewIfNeeded().catch(() => { })
                    await options[0].click()
                    await new Promise(r => setTimeout(r, 3000))
                    return
                }
            } catch { /* try next */ }
        }

        // AI fallback for polls
        if (this.aiService) {
            try {
                const pageText = await page.evaluate(() => document.body.innerText.substring(0, 3000))
                const aiResult = await this.aiService.findElement(
                    pageText,
                    'Find the first clickable answer option in this poll or quiz. Return a CSS selector.'
                )
                if (aiResult?.selector && aiResult.confidence > 0.6) {
                    this.logger.info('VISUAL', `AI poll selector: ${aiResult.selector}`)
                    await page.click(aiResult.selector, { force: true, timeout: 5000 }).catch(() => { })
                    return
                }
            } catch { /* ignore */ }
        }

        this.logger.warn('VISUAL', 'Could not find poll option to click')
    }

    // ══════════════════════════════════════════════════════════════════════════
    // UTILITIES
    // ══════════════════════════════════════════════════════════════════════════

    /** Escape special characters for use inside CSS :has-text() or attribute selectors */
    private escapeForCSS(text: string): string {
        return text.replace(/["\\]/g, '\\$&').replace(/\n/g, ' ').trim()
    }
}