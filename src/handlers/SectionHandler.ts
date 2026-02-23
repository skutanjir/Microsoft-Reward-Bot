/**
 * Section Handler
 * Manages discovery and interaction with UI sections (Streaks, Quests, Keep earning)
 */

import type { Page } from 'patchright'
import { SelectorResolver } from '../selectors/SelectorResolver'
import { Logger } from '../logging/Logger'
import type { UIContext } from '../types'

interface TaskInfo {
    title: string
    href: string
    points: string
    isCompleted: boolean
    isReferral: boolean
    isPromo: boolean
}

import { UIService } from '../services/UIService'

export class SectionHandler {
    private logger: Logger
    private selectorResolver: SelectorResolver
    private uiService?: UIService

    constructor(logger: Logger, selectorResolver: SelectorResolver, uiService?: UIService) {
        this.logger = logger
        this.selectorResolver = selectorResolver
        this.uiService = uiService
    }

    /**
     * Expand section and execute tasks using direct DOM detection.
     * Scans all <a> task cards, filters completed/referral/promo, clicks uncompleted ones.
     */
    async expandAndExecuteTasks(page: Page, sectionKey: string, uiContext: UIContext): Promise<number> {
        this.logger.info('SECTION', `Expanding and executing tasks for: ${sectionKey}`)

        // First, try to find and expand the section
        const titleElement = await this.selectorResolver.resolveElement(page, sectionKey, uiContext, 1500)

        if (!titleElement) {
            this.logger.warn('SECTION', `Section ${sectionKey} not found, skipping`)
            return 0
        }

        // Try to expand if collapsed
        const expanded = await this.expandSection(page, sectionKey, uiContext)
        if (expanded) {
            this.logger.info('SECTION', `Section ${sectionKey} was collapsed, now expanded`)
            await new Promise(r => setTimeout(r, 1000))
        } else {
            this.logger.info('SECTION', `Section ${sectionKey} already expanded or no expansion needed`)
        }

        // Scroll down to reveal all tasks
        await page.evaluate(() => window.scrollBy(0, 300))
        await new Promise(r => setTimeout(r, 500))

        // ===== Direct DOM-based task detection =====
        // Scan all <a> task cards in the section, detect points & completion status,
        // filter out referrals/promos, and click uncompleted tasks directly.
        this.logger.info('SECTION', `Scanning tasks in ${sectionKey} via DOM...`)
        let tasksExecuted = 0

        // Discover all clickable task links in this section
        const taskInfos = await this.discoverTasks(page, sectionKey)
        this.logger.info('SECTION', `Found ${taskInfos.length} total cards in ${sectionKey}`)

        // Filter to uncompleted, non-referral, non-promo tasks
        const clickableTasks = taskInfos.filter(t => !t.isCompleted && !t.isReferral && !t.isPromo)
        this.logger.info('SECTION', `${clickableTasks.length} uncompleted tasks to execute (skipped ${taskInfos.length - clickableTasks.length} completed/referral/promo)`)

        for (const task of clickableTasks) {
            this.logger.info('SECTION', `Clicking task: "${task.title}" (${task.points} pts) - ${task.href}`)

            // Click the task link directly
            const [newPage] = await Promise.all([
                page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
                page.locator(`a[href="${task.href}"]`).first().click({ timeout: 5000 }).catch(async () => {
                    // Fallback: try clicking by text
                    this.logger.debug('SECTION', `href selector failed, trying text click for "${task.title}"`)
                    await page.locator(`a:has-text("${task.title}")`).first().click({ timeout: 5000 }).catch(() => {
                        this.logger.warn('SECTION', `Could not click task: "${task.title}"`)
                    })
                })
            ])

            // Add random delay to appear human
            await new Promise(r => setTimeout(r, 500 + Math.floor(Math.random() * 500)))

            if (newPage) {
                this.logger.debug('SECTION', `Task opened new tab, waiting for load...`)
                await newPage.waitForLoadState('domcontentloaded').catch(() => { })
                await new Promise(r => setTimeout(r, 3000))
                await newPage.close().catch(() => { })
                tasksExecuted++

                // Re-expand section after returning
                this.logger.debug('SECTION', `Returned to rewards page, re-expanding ${sectionKey}...`)
                await this.expandSection(page, sectionKey, uiContext)
                await new Promise(r => setTimeout(r, 500))
            } else {
                // Check if navigated away in the same tab
                const currentUrl = page.url()
                const isRewardsPage = currentUrl.includes('/earn') || currentUrl.includes('/dashboard') || currentUrl.includes('/rewards')

                if (!isRewardsPage) {
                    this.logger.info('SECTION', `Same-tab navigation to ${currentUrl}, going back`)
                    await page.goBack().catch(() => page.goto(uiContext.pageUrl))
                    await new Promise(r => setTimeout(r, 2000))
                    await this.expandSection(page, sectionKey, uiContext)
                    tasksExecuted++
                } else {
                    // Task may have opened a modal or stayed on page
                    await new Promise(r => setTimeout(r, 2000))
                    await this.expandSection(page, sectionKey, uiContext)
                    tasksExecuted++
                }
            }
        }

        this.logger.info('SECTION', `Completed ${tasksExecuted} tasks in ${sectionKey}`)

        return tasksExecuted
    }
    /**
     * Discover all task cards in a section by querying the DOM directly.
     * Returns info about each card: title, href, points, completion status, referral/promo flags.
     */
    private async discoverTasks(page: Page, sectionKey: string): Promise<TaskInfo[]> {
        // Find the section container - it's the parent disclosure panel
        // The section key maps to a heading, and the tasks are in the sibling content area
        const tasks = await page.evaluate((secKey) => {
            const results: Array<{
                title: string
                href: string
                points: string
                isCompleted: boolean
                isReferral: boolean
                isPromo: boolean
            }> = []

            // Determine which section's disclosure panel we're in
            // Look for the section heading text to identify the container
            const sectionNames: Record<string, string[]> = {
                'daily_set_container': ['daily set'],
                'keep_earning_container': ['keep earning', 'more activities'],
                'streaks_container': ['streaks']
            }

            const targetNames = sectionNames[secKey] || []

            // Find the section's disclosure group
            let sectionContainer: Element | null = null
            const disclosures = Array.from(document.querySelectorAll('.react-aria-Disclosure, [class*="Disclosure"]'))

            for (const disc of disclosures) {
                const heading = disc.querySelector('h2, h3, [slot="trigger"]')
                const headingText = heading?.textContent?.toLowerCase() || ''
                if (targetNames.some(name => headingText.includes(name))) {
                    sectionContainer = disc
                    break
                }
            }

            // If we found the section container, only look at links inside it
            // Otherwise, check all links on the page (fallback)
            const searchScope = sectionContainer || document
            const links = Array.from(searchScope.querySelectorAll('a[data-react-aria-pressable="true"]'))

            for (const link of links) {
                const href = (link as HTMLAnchorElement).href || ''
                const text = link.textContent || ''
                const textLower = text.toLowerCase()

                // Get the title from the first <p> with text-body1Strong class
                const titleEl = link.querySelector('.text-body1Strong, p.line-clamp-3')
                const title = titleEl?.textContent?.trim() || text.substring(0, 60).trim()

                // Check completion: look for bg-statusSuccessBg3 (green check) + "Completed" text
                const hasCompletedBadge = link.querySelector('.bg-statusSuccessBg3') !== null
                const hasCompletedText = textLower.includes('completed')
                const isCompleted = hasCompletedBadge && hasCompletedText

                // Check referral
                const isReferral = href.toLowerCase().includes('/refer') ||
                    textLower.includes('refer and earn') ||
                    textLower.includes('turn referrals into rewards') ||
                    textLower.includes('true friends use bing together') ||
                    textLower.includes('turn referrals into rewards')

                // Check promo
                const isPromo = textLower.includes('see your new dashboard') ||
                    textLower.includes('see what\'s new') ||
                    textLower.includes('love at first click')

                // Extract points from +N badge
                let points = '0'
                const pointsBadge = link.querySelector('p.text-caption1Stronger')
                if (pointsBadge) {
                    const pointsText = pointsBadge.textContent || ''
                    const match = pointsText.match(/\+?(\d+)/)
                    if (match) points = match[1]
                }

                results.push({
                    title,
                    href,
                    points,
                    isCompleted,
                    isReferral,
                    isPromo
                })
            }

            return results
        }, sectionKey)

        // Log each discovered task
        for (const task of tasks) {
            const status = task.isCompleted ? '✅' : task.isReferral ? '🔗' : task.isPromo ? '📢' : '🎯'
            this.logger.debug('SECTION', `  ${status} "${task.title}" - ${task.points}pts - completed:${task.isCompleted} - referral:${task.isReferral} - promo:${task.isPromo}`)
        }

        return tasks
    }

    /**
     * Ensure all relevant rewards sections are expanded.
     * Returns true if any section was expanded.
     */
    async expandAllSections(page: Page, uiContext: UIContext): Promise<boolean> {
        this.logger.info('SECTION', 'Ensuring rewards sections are expanded...')
        let expandedAny = false

        const sections = ['daily_set_container', 'streaks_container', 'keep_earning_container']

        for (const sectionKey of sections) {
            try {
                const result = await this.expandSection(page, sectionKey, uiContext)
                if (result) expandedAny = true
            } catch (error) {
                this.logger.warn('SECTION', `Failed to expand section: ${sectionKey}`, { error: error instanceof Error ? error.message : String(error) })
            }
        }
        return expandedAny
    }

    /**
     * Expand a specific section if it's collapsed.
     * Returns true if a click was performed.
     */
    private async expandSection(page: Page, sectionKey: string, uiContext: UIContext): Promise<boolean> {
        this.logger.debug('SECTION', `Attempting to expand section: ${sectionKey}`)
        const titleElement = await this.selectorResolver.resolveElement(page, sectionKey, uiContext, 1500)

        if (!titleElement) {
            this.logger.debug('SECTION', `Section title not found: ${sectionKey}`)
            return false
        }

        // The disclosure button is usually a sibling or nearby.
        // We evaluate on the page to find the associated button robustly.
        const disclosure = await titleElement.evaluateHandle((node) => {
            const el = node as Element;

            // 1. Find the nearest container that likely holds the disclosure logic
            const container = el.closest('section, .react-aria-Disclosure, div[class*="Disclosure"], div[class*="section"]');
            if (container) {
                // Look for the toggle button within this container
                const btn = container.querySelector('button[aria-expanded], [role="button"][aria-expanded]') ||
                    container.querySelector('button[aria-label*="more" i], button[aria-label*="expand" i]') ||
                    Array.from(container.querySelectorAll('button')).find(b => b.textContent?.toLowerCase().includes('see more'));
                if (btn) return btn;
            }

            // 1.5. Check if the element itself contains a "See more" button
            const seeMoreBtn = el.querySelector('button[aria-label*="more" i]') ||
                Array.from(el.querySelectorAll('button')).find(b => b.textContent?.toLowerCase().includes('see more'));
            if (seeMoreBtn) return seeMoreBtn;

            // 2. Check siblings
            let sibling = el.nextElementSibling;
            while (sibling) {
                if (sibling.getAttribute('aria-expanded') || sibling.querySelector('[aria-expanded]')) {
                    return sibling.getAttribute('aria-expanded') ? sibling : sibling.querySelector('[aria-expanded]');
                }
                sibling = sibling.nextElementSibling;
            }

            // 3. Check el itself
            if (el.getAttribute('aria-expanded')) return el;

            return null;
        }).then(h => h.asElement());

        if (!disclosure) {
            this.logger.debug('SECTION', `No disclosure control found via structure for ${sectionKey}, trying UIService fallback`)
            const ariaLabel = sectionKey.replace(/_container/g, '').replace(/_/g, ' ')

            if (this.uiService) {
                const result = await this.uiService.discoverElement(page, {
                    text: [ariaLabel, 'See more'],
                    role: 'toggle',
                    aiGoal: `Find the expansion toggle for the ${ariaLabel} section.`
                })
                if (result.element) {
                    return await this.performExpansion(page, result.element, sectionKey)
                }
            }

            const fallbackBtn = await page.$(`button[aria-label*="${ariaLabel}" i], [aria-label*="${ariaLabel}" i][role="button"]`)
            if (fallbackBtn) {
                return await this.performExpansion(page, fallbackBtn, sectionKey)
            }
            return false
        }

        return await this.performExpansion(page, disclosure, sectionKey)
    }

    private async performExpansion(page: Page, disclosure: any, sectionKey: string): Promise<boolean> {
        let ariaExpanded = await disclosure.getAttribute('aria-expanded')
        // If no aria-expanded, check children
        if (ariaExpanded === null) {
            ariaExpanded = await disclosure.$eval('[aria-expanded]', (el: any) => el.getAttribute('aria-expanded')).catch(() => null)
        }

        const isExpanded = ariaExpanded === 'true'
        this.logger.debug('SECTION', `Section ${sectionKey} aria-expanded: ${ariaExpanded}`)

        if (!isExpanded) {
            this.logger.info('SECTION', `Expanding section: ${sectionKey} using keyboard navigation (TAB + ENTER)`)

            // Scroll the button into view first (but don't click)
            await disclosure.scrollIntoViewIfNeeded().catch(() => { })

            // Get the aria-label to identify when we've focused the right button
            const targetLabel = await disclosure.getAttribute('aria-label').catch(() => sectionKey)

            this.logger.debug('SECTION', `Navigating to button with label: ${targetLabel}`)

            // Focus on the page body first
            await page.evaluate(() => {
                document.body.focus()
            })

            // Press TAB multiple times until we focus the target button
            let focused = false
            for (let i = 0; i < 50; i++) {
                await page.keyboard.press('Tab')
                await new Promise(r => setTimeout(r, 100))

                // Check if we've focused the right element
                const currentFocus = await page.evaluate(() => {
                    const el = document.activeElement
                    return {
                        tag: el?.tagName,
                        ariaLabel: el?.getAttribute('aria-label'),
                        ariaExpanded: el?.getAttribute('aria-expanded'),
                        slot: el?.getAttribute('slot')
                    }
                })

                this.logger.debug('SECTION', `TAB ${i + 1}: Focused ${currentFocus.tag} [aria-label="${currentFocus.ariaLabel}"] [aria-expanded="${currentFocus.ariaExpanded}"] [slot="${currentFocus.slot}"]`)

                // Extract section name from sectionKey (e.g., "daily_set_container" -> "daily set")
                const sectionName = sectionKey.replace('_container', '').replace(/_/g, ' ')

                // Check if this is our target button - ALL conditions must be true:
                // 1. aria-expanded="false" (collapsed)
                // 2. slot="trigger" (React Aria disclosure)
                // 3. aria-label contains section name
                const isTargetButton = currentFocus.ariaExpanded === 'false' &&
                    currentFocus.slot === 'trigger' &&
                    currentFocus.ariaLabel?.toLowerCase().includes(sectionName.toLowerCase())

                if (isTargetButton) {
                    focused = true
                    this.logger.info('SECTION', `Found target button after ${i + 1} TABs - "${currentFocus.ariaLabel}"`)
                    break
                }
            }

            if (!focused) {
                this.logger.warn('SECTION', `Could not focus on ${sectionKey} button via TAB navigation`)
                return false
            }

            // Press ENTER to expand
            this.logger.debug('SECTION', `Pressing ENTER to expand ${sectionKey}`)
            await page.keyboard.press('Enter')
            await new Promise(r => setTimeout(r, 3000)) // Wait for animation and lazy loading

            // Verify expansion
            const newExpanded = await disclosure.getAttribute('aria-expanded').catch(() => null)
            this.logger.debug('SECTION', `Expansion check for ${sectionKey}: became ${newExpanded}`)

            return true
        } else {
            this.logger.debug('SECTION', `Section already expanded: ${sectionKey}`)
            return false
        }
    }
}
