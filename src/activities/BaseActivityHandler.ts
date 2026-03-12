import type { Page, ElementHandle } from 'patchright'
import { Logger } from '../logging/Logger'
import { SelectorResolver } from '../selectors/SelectorResolver'
import type { DiscoveredTask, UIContext, TaskType } from '../types'

export abstract class BaseActivityHandler {
    protected logger: Logger
    protected selectorResolver: SelectorResolver

    constructor(logger: Logger, selectorResolver: SelectorResolver) {
        this.logger = logger
        this.selectorResolver = selectorResolver
    }

    abstract getType(): TaskType

    abstract handle(page: Page, task: DiscoveredTask, uiContext: UIContext): Promise<boolean>

    /**
     * Click a task card and wait for the resulting page/tab.
     *
     * Strategy cascade:
     *  1. Playwright .click() directly on the actionTarget ElementHandle
     *  2. page.locator by destinationUrl href
     *  3. page.locator filter by task title text
     *  4. DOM evaluate + MouseEvent dispatch (bypasses pointer-events:none / React wrappers)
     */
    protected async clickAndWait(page: Page, task: DiscoveredTask): Promise<boolean> {
        this.logger.info('ACTIVITY', `Clicking task: "${task.title}"`)

        // Set up new-tab listener before any click
        const newPagePromise = page.context()
            .waitForEvent('page', { timeout: 12000 })
            .catch(() => null)

        const clicked = await this.tryClick(page, task)
        if (!clicked) {
            this.logger.warn('ACTIVITY', `All click strategies failed for: "${task.title}"`)
            return false
        }

        // Handle result
        const newPage = await newPagePromise

        if (newPage) {
            this.logger.debug('ACTIVITY', `New tab opened for "${task.title}"`)
            await newPage.waitForLoadState('domcontentloaded').catch(() => { })
            await new Promise(r => setTimeout(r, 4000))
            await newPage.close().catch(() => { })
            return true
        }

        // Same-tab: check if we navigated away
        const currentUrl = page.url()
        const onRewards =
            currentUrl.includes('rewards.bing.com') ||
            currentUrl.includes('/earn') ||
            currentUrl.includes('/dashboard')

        if (!onRewards) {
            this.logger.debug('ACTIVITY', `Same-tab nav to ${currentUrl}, going back`)
            await page.goBack({ timeout: 8000 }).catch(() =>
                page.goto('https://rewards.bing.com/', { waitUntil: 'domcontentloaded' })
            )
            await new Promise(r => setTimeout(r, 2000))
        } else {
            await new Promise(r => setTimeout(r, 3000))
        }

        return true
    }

    private async tryClick(page: Page, task: DiscoveredTask): Promise<boolean> {
        // ── S1: Direct click on the ElementHandle ─────────────────────────
        if (task.actionTarget) {
            try {
                const el: ElementHandle = task.actionTarget
                const box = await el.boundingBox()
                if (box && box.width > 0 && box.height > 0) {
                    const isVisible = await el.isVisible().catch(() => false)
                    if (isVisible) {
                        await el.scrollIntoViewIfNeeded().catch(() => { })
                        await el.click({ force: true, timeout: 5000 })
                        this.logger.debug('ACTIVITY', `S1 direct element click: "${task.title}"`)
                        return true
                    }
                }
            } catch (e) {
                this.logger.debug('ACTIVITY', `S1 failed: ${e instanceof Error ? e.message : String(e)}`)
            }
        }

        // ── S2: Locator by destination URL ────────────────────────────────
        if (task.destinationUrl) {
            for (const hrefVal of [task.destinationUrl]) {
                try {
                    const loc = page.locator(`a[href="${hrefVal}"]`).first()
                    if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                        await loc.scrollIntoViewIfNeeded().catch(() => { })
                        await loc.click({ force: true, timeout: 5000 })
                        this.logger.debug('ACTIVITY', `S2 href click: "${task.title}"`)
                        return true
                    }
                } catch { /* next */ }
            }
        }

        // ── S3: Locator filter by title text ──────────────────────────────
        try {
            const loc = page.locator('a[href], [role="button"]')
                .filter({ hasText: task.title })
                .first()
            if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                await loc.scrollIntoViewIfNeeded().catch(() => { })
                await loc.click({ force: true, timeout: 5000 })
                this.logger.debug('ACTIVITY', `S3 text filter click: "${task.title}"`)
                return true
            }
        } catch { /* next */ }

        // ── S4: DOM evaluate + MouseEvent dispatch ─────────────────────────
        const domResult = await page.evaluate(({ href, title }) => {
            let el: HTMLElement | null = href
                ? document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)
                : null

            if (!el) {
                el = Array.from(document.querySelectorAll<HTMLElement>('a[href], [role="button"]'))
                    .find(e =>
                        (e.textContent ?? '').trim().toLowerCase().includes(title.toLowerCase()) ||
                        (e.getAttribute('aria-label') ?? '').toLowerCase().includes(title.toLowerCase())
                    ) ?? null
            }

            if (!el) return false

            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
            for (const t of ['mouseenter', 'mouseover', 'mousedown', 'mouseup']) {
                el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
            }
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
            el.click()
            return true
        }, { href: task.destinationUrl ?? '', title: task.title })

        if (domResult) {
            this.logger.debug('ACTIVITY', `S4 DOM click: "${task.title}"`)
            return true
        }

        return false
    }
}