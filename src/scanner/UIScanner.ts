import type { Page, ElementHandle } from 'patchright'
import { SelectorResolver } from '../selectors/SelectorResolver'
import { SectionHandler } from '../handlers/SectionHandler'
import type { DiscoveredTask, UIContext } from '../types'
import { Logger } from '../logging/Logger'
import { UIService } from '../services/UIService'

export class UIScanner {
    private logger: Logger
    private selectorResolver: SelectorResolver
    private sectionHandler: SectionHandler

    constructor(logger: Logger, selectorResolver: SelectorResolver, uiService?: UIService) {
        this.logger = logger
        this.selectorResolver = selectorResolver
        this.sectionHandler = new SectionHandler(logger, selectorResolver, uiService)
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DISCOVER TASKS
    // ══════════════════════════════════════════════════════════════════════════

    async discoverTasks(page: Page, uiContext: UIContext): Promise<DiscoveredTask[]> {
        this.logger.info('SCANNER', 'Scanning page for reward activities...')

        // Scroll to trigger lazy loading
        await this.scrollPage(page)

        // Expand all sections
        await this.ensureSectionsExpanded(page, uiContext)
        await page.waitForTimeout(2000)

        // Second scroll pass after expansion
        await this.scrollPage(page)

        // Collect all card-like anchor elements
        const cards = await this.collectCards(page, uiContext)
        this.logger.debug('SCANNER', `Found ${cards.length} candidate card elements`)

        const discoveredTasks: DiscoveredTask[] = []

        for (const card of cards) {
            try {
                const box = await card.boundingBox()
                if (!box || box.width === 0 || box.height === 0) continue

                const task = await this.analyzeCard(page, card)
                if (task) {
                    this.logger.debug('SCANNER',
                        `  Task: "${task.title}" (${task.points}pts) complete=${task.isComplete}`
                    )
                    discoveredTasks.push(task)
                }
            } catch (error) {
                this.logger.warn('SCANNER', `Card analysis failed: ${error instanceof Error ? error.message : String(error)}`)
            }
        }

        this.logger.info('SCANNER',
            `Discovery: ${discoveredTasks.length} tasks (${discoveredTasks.filter(t => !t.isComplete).length} incomplete)`
        )

        return discoveredTasks
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    private async scrollPage(page: Page): Promise<void> {
        try {
            await page.evaluate(async () => {
                const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
                for (let i = 0; i < 4; i++) {
                    window.scrollBy(0, 900)
                    await delay(700)
                    if (document.body.innerText.includes('Microsoft Rewards support')) break
                }
            })
            await page.waitForTimeout(800)
        } catch { /* non-critical */ }
    }

    /**
     * Collect card elements using multiple selector strategies.
     * Returns the best-matching set of ElementHandles.
     */
    private async collectCards(page: Page, uiContext: UIContext): Promise<ElementHandle[]> {
        // Try SelectorResolver bank first
        const bankCards = await this.selectorResolver.resolveElements(page, 'activity_card', uiContext)
        if (bankCards.length > 0) return bankCards

        // Fallback: try known 2025 UI selectors in order of specificity
        const fallbackSelectors = [
            'a[data-react-aria-pressable="true"]',
            'a[href][class*="card"]',
            'a[href][class*="offer"]',
            'a[href*="rewards.bing.com"]',
            'a[href*="bing.com"]',
            '[data-bi-id] a[href]',
        ]

        for (const sel of fallbackSelectors) {
            const els = await page.$$(sel)
            if (els.length > 0) {
                this.logger.debug('SCANNER', `Cards found via fallback selector: ${sel} (${els.length})`)
                return els
            }
        }

        return []
    }

    /**
     * Extract structured task data from a card ElementHandle.
     */
    private async analyzeCard(page: Page, card: ElementHandle): Promise<DiscoveredTask | null> {
        const metadata = await card.evaluate((el: HTMLElement) => {
            const text = el.textContent ?? ''
            const textLower = text.toLowerCase()

            // ── Title extraction (priority order) ──────────────────────────
            const titleEl =
                el.querySelector('.text-body1Strong') ??
                el.querySelector('p.line-clamp-3') ??
                el.querySelector('[class*="title"]') ??
                el.querySelector('p') ??
                el.querySelector('h2, h3, h4')

            const title = (titleEl?.textContent ?? text.split('+')[0] ?? '').trim().substring(0, 80)

            // ── Points extraction ───────────────────────────────────────────
            let points = 0
            const pointsEl =
                el.querySelector('p.text-caption1Stronger') ??
                el.querySelector('.text-title1') ??
                el.querySelector('.pointsValue') ??
                el.querySelector('[class*="points"]')

            if (pointsEl) {
                const m = (pointsEl.textContent ?? '').match(/\+?(\d+)/)
                if (m) points = parseInt(m[1])
            }

            // Fallback regex on full text
            if (!points) {
                const allMatches = Array.from(text.matchAll(/\+(\d+)/g))
                if (allMatches.length > 0) {
                    points = allMatches.reduce((sum, m) => sum + parseInt(m[1]), 0)
                }
            }

            // ── Completion detection ────────────────────────────────────────
            const hasGreenBadge  = el.querySelector('.bg-statusSuccessBg3') !== null
            const hasCheckmark   = el.querySelector('[class*="checkmark"]') !== null ||
                                   el.querySelector('[class*="complete"]') !== null ||
                                   el.querySelector('[aria-label*="Complete" i]') !== null
            const hasCompletedTx = textLower.includes('completed')
            const isCompleted    = (hasGreenBadge || hasCheckmark) && hasCompletedTx

            // ── URL extraction ──────────────────────────────────────────────
            const anchor = el.tagName === 'A' ? el as HTMLAnchorElement : el.querySelector<HTMLAnchorElement>('a')
            const href = anchor?.href ?? ''

            return { title, points, isCompleted, href }
        })

        const { title, points, isCompleted, href } = metadata

        if (!title || title.length < 2) return null

        // Filter out noise items
        const isNoise = points === 0 && ['available points', 'points', 'level', 'status'].some(
            w => title.toLowerCase().includes(w)
        )
        if (isNoise) return null

        // Completion + lock status via separate $() calls
        const isLocked = await card.$('.mee-icon-Lock, [class*="Lock"], [disabled]')
            .then(el => el !== null)
            .catch(() => false)

        const boundingBox = await card.boundingBox()
        const y = boundingBox
            ? boundingBox.y + await page.evaluate(() => window.scrollY)
            : 0

        const id = Buffer.from(`${title}-${points}`).toString('base64').substring(0, 16)

        return {
            id,
            title,
            points,
            isComplete: isCompleted,
            isLocked,
            typeHints: this.generateTypeHints(title, href),
            actionTarget: card,
            destinationUrl: href || undefined,
            containerElement: card,
            y
        }
    }

    private generateTypeHints(title: string, url?: string): string[] {
        const hints: string[] = []
        const lowerTitle = title.toLowerCase()

        if (lowerTitle.includes('quiz') || lowerTitle.includes('test your knowledge')) hints.push('quiz')
        if (lowerTitle.includes('poll') || url?.includes('pollscenarioid')) hints.push('poll')
        if (lowerTitle.includes('search') || lowerTitle.includes('bing')) hints.push('search')
        if (lowerTitle.includes('check-in')) hints.push('checkin')
        if (lowerTitle.includes('read')) hints.push('read')

        return hints
    }

    async ensureSectionsExpanded(page: Page, uiContext: UIContext): Promise<boolean> {
        return this.sectionHandler.expandAllSections(page, uiContext)
    }
}