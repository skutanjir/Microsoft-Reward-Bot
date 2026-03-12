/**
 * Section Handler
 * Manages discovery and clicking of task cards in MS Rewards sections.
 *
 * TASK CLICK STRATEGY CASCADE:
 *  S1. Playwright locator by exact href
 *  S2. Playwright locator filter by title text
 *  S3. getByRole('link') with accessible name
 *  S4. DOM evaluate + full MouseEvent dispatch (bypasses pointer-events, React handlers)
 *  S5. Keyboard TAB+ENTER navigation to the card
 *
 * EXPAND STRATEGY CASCADE:
 *  S1. Direct CSS on button[slot="trigger"][aria-expanded="false"]
 *  S2. Already-expanded pre-check (skip if open)
 *  S3. page.locator filter by section name text
 *  S4. SelectorResolver bank + evaluateHandle
 *  S5. TAB keyboard navigation
 */

import type { Page } from 'patchright'
import { SelectorResolver } from '../selectors/SelectorResolver'
import { Logger } from '../logging/Logger'
import type { UIContext } from '../types'
import { UIService } from '../services/UIService'

interface TaskInfo {
    title: string
    href: string
    hrefPath: string
    points: string
    isCompleted: boolean
    isReferral: boolean
    isPromo: boolean
}

export class SectionHandler {
    private logger: Logger
    private selectorResolver: SelectorResolver

    constructor(logger: Logger, selectorResolver: SelectorResolver, _uiService?: UIService) {
        this.logger = logger
        this.selectorResolver = selectorResolver
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PUBLIC: EXPAND + EXECUTE TASKS
    // ══════════════════════════════════════════════════════════════════════════

    async expandAndExecuteTasks(page: Page, sectionKey: string, uiContext: UIContext): Promise<number> {
        this.logger.info('SECTION', `Processing section: ${sectionKey}`)

        await this.expandSection(page, sectionKey, uiContext)
        await new Promise(r => setTimeout(r, 1000))

        await page.evaluate(() => window.scrollBy(0, 400)).catch(() => { })
        await new Promise(r => setTimeout(r, 600))

        const taskInfos = await this.discoverTasks(page, sectionKey)
        this.logger.info('SECTION', `Found ${taskInfos.length} cards in ${sectionKey}`)

        const clickable = taskInfos.filter(t => !t.isCompleted && !t.isReferral && !t.isPromo)
        this.logger.info('SECTION', `${clickable.length} uncompleted | ${taskInfos.length - clickable.length} skipped`)

        let tasksExecuted = 0

        for (const task of clickable) {
            this.logger.info('SECTION', `▶ Clicking: "${task.title}" (+${task.points} pts)`)

            const success = await this.clickTask(page, task)

            if (success) {
                tasksExecuted++
                this.logger.info('SECTION', `✓ Completed: "${task.title}"`)
            } else {
                this.logger.warn('SECTION', `✗ Failed: "${task.title}"`)
            }

            await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 400)))
            await this.expandSection(page, sectionKey, uiContext)
            await new Promise(r => setTimeout(r, 500))
        }

        this.logger.info('SECTION', `${sectionKey}: executed ${tasksExecuted}/${clickable.length}`)
        return tasksExecuted
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PUBLIC: EXPAND ALL
    // ══════════════════════════════════════════════════════════════════════════

    async expandAllSections(page: Page, uiContext: UIContext): Promise<boolean> {
        this.logger.info('SECTION', 'Expanding all reward sections...')
        let expandedAny = false

        for (const sectionKey of ['daily_set_container', 'streaks_container', 'keep_earning_container']) {
            try {
                if (await this.expandSection(page, sectionKey, uiContext)) expandedAny = true
            } catch (error) {
                this.logger.warn('SECTION', `Failed to expand ${sectionKey}: ${error instanceof Error ? error.message : String(error)}`)
            }
        }

        return expandedAny
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TASK DISCOVERY
    // ══════════════════════════════════════════════════════════════════════════

    private async discoverTasks(page: Page, sectionKey: string): Promise<TaskInfo[]> {
        const raw = await page.evaluate((secKey) => {
            const sectionNames: Record<string, string[]> = {
                'daily_set_container': ['daily set'],
                'keep_earning_container': ['keep earning', 'more activities'],
                'streaks_container': ['streaks'],
            }

            const targetNames = sectionNames[secKey] ?? []

            // Find the section's Disclosure container
            let sectionContainer: Element | null = null
            const disclosures = Array.from(
                document.querySelectorAll<Element>('.react-aria-Disclosure, [class*="Disclosure"], section')
            )
            for (const disc of disclosures) {
                const heading = disc.querySelector('h2, h3, [slot="trigger"]')
                if (targetNames.some(n => (heading?.textContent ?? '').toLowerCase().includes(n))) {
                    sectionContainer = disc
                    break
                }
            }

            const scope = sectionContainer ?? document

            // Priority selector list for card links
            const prioritySelectors = [
                'a[data-react-aria-pressable="true"]',
                'a[href][class*="card"]',
                'a[href][class*="task"]',
                'a[href][class*="offer"]',
                'a[href*="rewards.bing.com"]',
                'a[href*="bing.com/search"]',
                'a[href*="bing.com"]',
                'a[href]',
            ]

            let links: HTMLAnchorElement[] = []
            for (const sel of prioritySelectors) {
                const found = Array.from(scope.querySelectorAll<HTMLAnchorElement>(sel))
                    .filter(a => a.href && a.href !== window.location.href && !a.href.endsWith('#'))
                if (found.length > 0) {
                    links = found
                    break
                }
            }

            const results: Array<{
                title: string; href: string; hrefPath: string; points: string
                isCompleted: boolean; isReferral: boolean; isPromo: boolean
            }> = []

            for (const link of links) {
                const href = link.href ?? ''
                const text = (link.textContent ?? '').trim()
                const textLower = text.toLowerCase()

                if (!href || href === window.location.href) continue

                // Title extraction
                const titleEl =
                    link.querySelector('.text-body1Strong') ??
                    link.querySelector('p.line-clamp-3') ??
                    link.querySelector('[class*="title"]') ??
                    link.querySelector('p') ??
                    link.querySelector('h2, h3, h4')
                const title = (titleEl?.textContent ?? text).trim().substring(0, 80)
                if (!title || title.length < 2) continue

                // Completion
                const hasGreenBadge = link.querySelector('.bg-statusSuccessBg3') !== null
                const hasCheckmark = link.querySelector('[class*="checkmark"]') !== null ||
                    link.querySelector('[class*="complete"]') !== null
                const hasCompletedTx = textLower.includes('completed')
                const isCompleted = (hasGreenBadge || hasCheckmark) && hasCompletedTx

                // Referral
                const isReferral =
                    href.toLowerCase().includes('/refer') ||
                    textLower.includes('refer and earn') ||
                    textLower.includes('turn referrals into rewards') ||
                    textLower.includes('true friends use bing together')

                // Promo noise
                const isPromo =
                    textLower.includes('see your new dashboard') ||
                    textLower.includes("see what's new") ||
                    textLower.includes('love at first click')

                // Points
                let points = '0'
                const pointsBadge =
                    link.querySelector('p.text-caption1Stronger') ??
                    link.querySelector('[class*="points"]')
                if (pointsBadge) {
                    const m = (pointsBadge.textContent ?? '').match(/\+?(\d+)/)
                    if (m) points = m[1]
                }

                // Relative path for alternate locator
                let hrefPath = href
                try { hrefPath = new URL(href).pathname + new URL(href).search } catch { /* keep */ }

                results.push({ title, href, hrefPath, points, isCompleted, isReferral, isPromo })
            }

            return results
        }, sectionKey)

        // Deduplicate by href
        const seen = new Set<string>()
        const deduped = raw.filter(t => {
            if (seen.has(t.href)) return false
            seen.add(t.href)
            return true
        })

        for (const t of deduped) {
            const icon = t.isCompleted ? '✅' : t.isReferral ? '🔗' : t.isPromo ? '📢' : '🎯'
            this.logger.debug('SECTION', `  ${icon} "${t.title}" +${t.points}pts`)
        }

        return deduped
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CLICK TASK — 5-strategy cascade
    // ══════════════════════════════════════════════════════════════════════════

    private async clickTask(page: Page, task: TaskInfo): Promise<boolean> {
        const newPagePromise = page.context()
            .waitForEvent('page', { timeout: 12000 })
            .catch(() => null)

        const clicked = await this.tryClickStrategies(page, task)
        if (!clicked) return false

        await this.handlePostClick(page, newPagePromise, task)
        return true
    }

    private async tryClickStrategies(page: Page, task: TaskInfo): Promise<boolean> {
        const { href, hrefPath, title } = task

        // ── S1: Exact href locator ──────────────────────────────────────────
        for (const hrefVal of [href, hrefPath]) {
            try {
                const loc = page.locator(`a[href="${hrefVal}"]`).first()
                if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                    this.logger.debug('SECTION', `S1 href click: ${hrefVal.substring(0, 60)}`)
                    await loc.scrollIntoViewIfNeeded().catch(() => { })
                    await loc.click({ force: true, timeout: 5000 })
                    return true
                }
            } catch { /* next */ }
        }

        // ── S2: Locator filter by title text ───────────────────────────────
        try {
            const loc = page.locator('a[href]').filter({ hasText: title }).first()
            if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                this.logger.debug('SECTION', `S2 text filter click: "${title}"`)
                await loc.scrollIntoViewIfNeeded().catch(() => { })
                await loc.click({ force: true, timeout: 5000 })
                return true
            }
        } catch { /* next */ }

        // ── S3: getByRole link with accessible name ────────────────────────
        try {
            const loc = page.getByRole('link', { name: title, exact: false }).first()
            if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                this.logger.debug('SECTION', `S3 getByRole link: "${title}"`)
                await loc.scrollIntoViewIfNeeded().catch(() => { })
                await loc.click({ force: true, timeout: 5000 })
                return true
            }
        } catch { /* next */ }

        // ── S4: DOM evaluate + full MouseEvent dispatch ────────────────────
        const domResult = await page.evaluate(({ h, t }) => {
            // Find by href first
            let el: HTMLElement | null = document.querySelector<HTMLAnchorElement>(`a[href="${h}"]`)

            // Fallback: text scan
            if (!el) {
                el = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find(a =>
                    (a.textContent ?? '').trim().toLowerCase().includes(t.toLowerCase()) ||
                    (a.getAttribute('aria-label') ?? '').toLowerCase().includes(t.toLowerCase())
                ) ?? null
            }

            if (!el) return false

            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
            // Fire full mouse event sequence — required for React synthetic events
            for (const type of ['mouseenter', 'mouseover', 'mousedown', 'mouseup']) {
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
            }
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
            el.click()
            return true
        }, { h: href, t: title })

        if (domResult) {
            this.logger.debug('SECTION', `S4 DOM evaluate click: "${title}"`)
            return true
        }

        // ── S5: Keyboard TAB + Enter ───────────────────────────────────────
        return await this.clickViaKeyboard(page, href, title)
    }

    private async clickViaKeyboard(page: Page, href: string, title: string): Promise<boolean> {
        this.logger.debug('SECTION', `S5 keyboard TAB for "${title}"`)
        await page.evaluate(() => document.body.focus())

        for (let i = 0; i < 80; i++) {
            await page.keyboard.press('Tab')
            await new Promise(r => setTimeout(r, 55))

            const match = await page.evaluate(({ h, t }) => {
                const el = document.activeElement as HTMLAnchorElement | null
                if (!el) return false
                const elHref = el.href ?? ''
                const elText = (el.textContent ?? el.getAttribute('aria-label') ?? '').toLowerCase()
                return elHref === h || elHref.includes(h) || elText.includes(t.toLowerCase())
            }, { h: href, t: title })

            if (match) {
                this.logger.debug('SECTION', `S5 found target at TAB ${i + 1}, pressing Enter`)
                await page.keyboard.press('Enter')
                return true
            }
        }

        this.logger.warn('SECTION', `S5 TAB exhausted for "${title}"`)
        return false
    }

    // ══════════════════════════════════════════════════════════════════════════
    // POST-CLICK HANDLER
    // ══════════════════════════════════════════════════════════════════════════

    private async handlePostClick(page: Page, newPagePromise: Promise<any>, task: TaskInfo): Promise<void> {
        const newPage = await newPagePromise

        if (newPage) {
            this.logger.debug('SECTION', `New tab for "${task.title}"`)
            await newPage.waitForLoadState('domcontentloaded').catch(() => { })
            await new Promise(r => setTimeout(r, 4000))
            await newPage.close().catch(() => { })
        } else {
            const currentUrl = page.url()
            const onRewards =
                currentUrl.includes('rewards.bing.com') ||
                currentUrl.includes('/earn') ||
                currentUrl.includes('/dashboard')

            if (!onRewards) {
                this.logger.debug('SECTION', `Same-tab nav to ${currentUrl}, going back`)
                await page.goBack({ timeout: 8000 }).catch(() =>
                    page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded' })
                )
                await new Promise(r => setTimeout(r, 2000))
            } else {
                await new Promise(r => setTimeout(r, 2500))
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SECTION EXPAND — 5-strategy cascade
    // ══════════════════════════════════════════════════════════════════════════

    private async expandSection(page: Page, sectionKey: string, uiContext: UIContext): Promise<boolean> {
        const sectionName = sectionKey.replace('_container', '').replace(/_/g, ' ')

        // ── S1: Direct CSS click on collapsed trigger ──────────────────────
        try {
            const btn = await page.$(
                `button[slot="trigger"][aria-label*="${sectionName}" i][aria-expanded="false"]`
            )
            if (btn) {
                this.logger.info('SECTION', `Expand S1 "${sectionName}" via direct CSS`)
                await btn.scrollIntoViewIfNeeded().catch(() => { })
                await btn.click({ force: true })
                await new Promise(r => setTimeout(r, 2000))
                if (await btn.getAttribute('aria-expanded').catch(() => null) === 'true') return true
            }
        } catch { /* next */ }

        // ── S2: Already open? ──────────────────────────────────────────────
        const alreadyOpen = await page.evaluate((name) => {
            return Array.from(
                document.querySelectorAll<HTMLButtonElement>('button[slot="trigger"][aria-expanded="true"]')
            ).some(b =>
                (b.getAttribute('aria-label') ?? '').toLowerCase().includes(name.toLowerCase())
            )
        }, sectionName).catch(() => false)

        if (alreadyOpen) {
            this.logger.debug('SECTION', `"${sectionName}" already expanded`)
            return false
        }

        // ── S3: Locator filter ─────────────────────────────────────────────
        try {
            const loc = page.locator('button[slot="trigger"]')
                .filter({ hasText: new RegExp(sectionName, 'i') })
            if (await loc.count() > 0) {
                const exp = await loc.first().getAttribute('aria-expanded')
                if (exp === 'false') {
                    this.logger.info('SECTION', `Expand S3 "${sectionName}" via locator filter`)
                    await loc.first().scrollIntoViewIfNeeded().catch(() => { })
                    await loc.first().click({ force: true })
                    await new Promise(r => setTimeout(r, 2000))
                    return true
                }
                if (exp === 'true') return false
            }
        } catch { /* next */ }

        // ── S4: SelectorResolver + evaluateHandle ─────────────────────────
        const titleEl = await this.selectorResolver.resolveElement(page, sectionKey, uiContext, 1500)
        if (titleEl) {
            const triggerBtn = await titleEl.evaluateHandle((node) => {
                const container = (node as Element).closest(
                    '.react-aria-Disclosure, section, [class*="Disclosure"]'
                )
                return container?.querySelector<HTMLButtonElement>(
                    'button[slot="trigger"][aria-expanded="false"], button[aria-expanded="false"]'
                ) ?? null
            }).then(h => h.asElement())

            if (triggerBtn) {
                this.logger.info('SECTION', `Expand S4 "${sectionName}" via resolver`)
                await triggerBtn.scrollIntoViewIfNeeded().catch(() => { })
                await triggerBtn.click({ force: true }).catch(() => { })
                await new Promise(r => setTimeout(r, 2000))
                return true
            }
        }

        // ── S5: TAB keyboard navigation ────────────────────────────────────
        return await this.expandViaTAB(page, sectionName)
    }

    private async expandViaTAB(page: Page, sectionName: string): Promise<boolean> {
        this.logger.info('SECTION', `Expand S5 TAB nav for "${sectionName}"`)
        await page.evaluate(() => document.body.focus())

        for (let i = 0; i < 60; i++) {
            await page.keyboard.press('Tab')
            await new Promise(r => setTimeout(r, 70))

            const focus = await page.evaluate(() => ({
                ariaLabel: document.activeElement?.getAttribute('aria-label') ?? '',
                ariaExpanded: document.activeElement?.getAttribute('aria-expanded') ?? '',
                slot: document.activeElement?.getAttribute('slot') ?? '',
            }))

            if (
                focus.ariaExpanded === 'false' &&
                focus.slot === 'trigger' &&
                focus.ariaLabel.toLowerCase().includes(sectionName.toLowerCase())
            ) {
                this.logger.info('SECTION', `TAB found "${sectionName}" at press ${i + 1}, pressing Enter`)
                await page.keyboard.press('Enter')
                await new Promise(r => setTimeout(r, 2500))
                return true
            }
        }

        this.logger.warn('SECTION', `TAB failed for "${sectionName}"`)
        return false
    }
}