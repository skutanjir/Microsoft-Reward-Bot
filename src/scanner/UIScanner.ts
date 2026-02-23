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

    /**
     * Discover available tasks on the current page
     */
    async discoverTasks(page: Page, uiContext: UIContext): Promise<DiscoveredTask[]> {
        this.logger.info('SCANNER', 'Scanning page for available rewards activities...')

        // Ensure all content is loaded by scrolling
        this.logger.debug('SCANNER', 'Scrolling page to trigger lazy loading...')
        await page.evaluate(async () => {
            const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

            // Scroll down in chunks to reveal "Keep Earning" section and trigger lazy loading
            for (let i = 0; i < 4; i++) {
                window.scrollBy(0, 1000);
                await delay(800);

                // If we've scrolled deep and see the footer, we can stop
                if (document.body.innerText.includes('Microsoft Rewards support')) {
                    break;
                }
            }
        })
        await page.waitForTimeout(1000)

        // Ensure sections are expanded (Daily Set, Keep Earning)
        await this.ensureSectionsExpanded(page, uiContext)

        // Wait for newly revealed content to load
        await page.waitForTimeout(2000)

        // Second scroll pass REGARDLESS of expansion to trigger lazy loading of cards
        this.logger.debug('SCANNER', 'Performing final scroll pass for lazy-loaded cards...')
        try {
            await page.evaluate(async () => {
                const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
                for (let i = 0; i < 3; i++) {
                    window.scrollBy(0, 800)
                    await delay(800)
                }
            })
        } catch (e) {
            this.logger.warn('SCANNER', 'Final scroll pass failed (non-critical)', { error: e instanceof Error ? e.message : String(e) })
        }

        // 1. Find all activity cards
        const cards = await this.selectorResolver.resolveElements(page, 'activity_card', uiContext)
        this.logger.debug('SCANNER', `Found ${cards.length} potential activity cards`)

        const discoveredTasks: DiscoveredTask[] = []

        // 2. Analyze each card with internal retry logic for lazy-loaded items
        for (const card of cards) {
            try {
                // Stronger validation: ensure card is not a "ghost" element
                const box = await card.boundingBox()
                if (!box || box.width === 0 || box.height === 0) continue

                const task = await this.analyzeCard(page, card)
                if (task) {
                    this.logger.debug('SCANNER', `Analyzed: ${task.title} (${task.points} pts) - Y: ${Math.round(task.y)} - Complete: ${task.isComplete}`)
                    discoveredTasks.push(task)
                }
            } catch (error) {
                this.logger.warn('SCANNER', 'Failed to analyze an activity card (skipping)', { error: error instanceof Error ? error.message : String(error) })
            }
        }


        this.logger.info('SCANNER', `Discovery complete. Found ${discoveredTasks.length} activities (${discoveredTasks.filter(t => !t.isComplete).length} incomplete)`)

        // Log each discovered task for debugging
        if (discoveredTasks.length > 0) {
            this.logger.debug('SCANNER', 'Discovered tasks:')
            discoveredTasks.forEach((t, idx) => {
                this.logger.debug('SCANNER', `  ${idx + 1}. ${t.title} - ${t.points}pts - Complete: ${t.isComplete}`)
            })
        }

        return discoveredTasks
    }

    /**
     * Extract metadata from an activity card element
     */
    private async analyzeCard(page: Page, card: ElementHandle): Promise<DiscoveredTask | null> {
        // Extract title and points using a more robust evaluation script for the 2025 UI
        const metadata = await card.evaluate((el: any) => {
            const text = el.textContent || ''

            // Try to find a specific points element first (preferred in 2025 UI)
            const pointsEl = el.querySelector('.text-title1, .pointsValue, [class*="points"]')
            let points = 0
            if (pointsEl) {
                points = parseInt(pointsEl.textContent?.replace(/[^0-9]/g, '') || '0')
            }

            if (!points || points < 5) {
                // Fallback to regex: look for + followed by digits with word boundary to avoid matching "1 day"
                const pointMatches = text.match(/\+(\d+)\b/g)
                if (pointMatches) {
                    const nums = pointMatches.map((m: string) => parseInt(m.replace(/\+/g, '')))
                    // Sum bonus + base or take max
                    points = nums.reduce((a: number, b: number) => a + b, 0)
                }
            }

            // Extract title: look for heading or first non-point-like text
            const nodes = Array.from(el.querySelectorAll('p, span, h2, h3'))
                .map((n: any) => n.textContent?.trim())
                .filter(t => t && !t.startsWith('+') && !/^\d+$/.test(t) && t.length > 3)

            const title = nodes[0] || text.split('+')[0]?.trim() || 'Unknown Task'

            return { title, points }
        })

        const title = metadata.title
        const points = metadata.points

        // Filtering: If no points and generic title, it's likely not a reward task
        const isGeneric = ['available points', 'points', 'level', 'status', 'bing', 'edge', 'mobile'].some(word => title.toLowerCase().includes(word))
        if (points === 0 && isGeneric) {
            return null
        }

        // Check completion status robustly
        const isComplete = await card.$('.brandStrokeCompound, [class*="Complete"], [aria-label*="Complete"]').then(el => el !== null).catch(() => false)

        // Check lock status
        const isLocked = await card.$('.mee-icon-Lock, [class*="Lock"], [disabled]').then(el => el !== null).catch(() => false)

        // Extract destination URL if available
        const destinationUrl = await card.$eval('a', (el: any) => el.href).catch(() => undefined)

        // Get vertical position for sorting
        const boundingBox = await card.boundingBox()
        const y = boundingBox ? boundingBox.y + (await page.evaluate(() => window.scrollY)) : 0

        // ID generation based on title and points
        const id = Buffer.from(`${title}-${points}`).toString('base64').substring(0, 16)

        return {
            id,
            title,
            points,
            isComplete,
            isLocked,
            typeHints: this.generateTypeHints(title, destinationUrl),
            actionTarget: card,
            destinationUrl,
            containerElement: card,
            y
        }
    }

    /**
     * Generate activity type hints based on title and URL
     */
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

    /**
     * Ensure sections are expanded (Daily Set, Keep Earning)
     */
    /**
     * Ensure all rewards sections are expanded.
     * Returns true if any section was newly expanded.
     */
    async ensureSectionsExpanded(page: Page, uiContext: UIContext): Promise<boolean> {
        this.logger.debug('SCANNER', 'Ensuring sections are expanded...')
        return await this.sectionHandler.expandAllSections(page, uiContext)
    }
}
