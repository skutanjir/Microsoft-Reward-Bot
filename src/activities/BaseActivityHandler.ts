import type { Page } from 'patchright'
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

    /**
     * Handle the execution of a specific activity
     */
    abstract handle(page: Page, task: DiscoveredTask, uiContext: UIContext): Promise<boolean>

    /**
     * Basic "click and wait" behavior for simple URL rewards
     */
    protected async clickAndWait(page: Page, task: DiscoveredTask): Promise<boolean> {
        this.logger.info('ACTIVITY', `Executing keyboard click (TAB + ENTER) for: ${task.title}`)

        try {
            // Scroll the task card into view
            await task.actionTarget.scrollIntoViewIfNeeded().catch(() => { })
            await new Promise(r => setTimeout(r, 500))

            // Focus on page body first
            await page.evaluate(() => {
                document.body.focus()
            })

            // Press TAB a few times to focus on the task card
            // User reports needing 1-3 TABs per task
            let taskFocused = false
            for (let i = 0; i < 5; i++) {
                await page.keyboard.press('Tab')
                await new Promise(r => setTimeout(r, 150))

                // Check if we've focused an interactive element within the task
                const currentFocus = await page.evaluate(() => {
                    const el = document.activeElement
                    return {
                        tag: el?.tagName,
                        href: (el as HTMLAnchorElement)?.href,
                        role: el?.getAttribute('role')
                    }
                })

                // If we've focused a link or button, we're ready
                if (currentFocus.tag === 'A' || currentFocus.tag === 'BUTTON' || currentFocus.role === 'button') {
                    taskFocused = true
                    this.logger.debug('ACTIVITY', `Task focused after ${i + 1} TABs`)
                    break
                }
            }

            if (!taskFocused) {
                this.logger.warn('ACTIVITY', `Could not focus on task: ${task.title}`)
                return false
            }

            // Press ENTER to activate the task
            this.logger.debug('ACTIVITY', `Pressing ENTER to activate: ${task.title}`)

            const [newPage] = await Promise.all([
                page.context().waitForEvent('page', { timeout: 15000 }).catch(() => null),
                page.keyboard.press('Enter')
            ])

            if (newPage) {
                this.logger.debug('ACTIVITY', `New page opened for ${task.title}, waiting for load...`)
                await newPage.waitForLoadState('domcontentloaded').catch(() => { })
                await new Promise(r => setTimeout(r, 4000)) // Stay on page for 4 seconds
                await newPage.close().catch(() => { })
                return true
            } else {
                this.logger.warn('ACTIVITY', `No new page opened for ${task.title} after ENTER. It might be a background task or failure.`)
                // Some tasks don't open a new page but still register (like polls sometimes)
                // We'll return true if we pressed ENTER, but wait a bit
                await new Promise(r => setTimeout(r, 3000))
                return true
            }
        } catch (error) {
            this.logger.error('ACTIVITY', `Failed to execute keyboard click: ${task.title}`, { error: error instanceof Error ? error.message : String(error) })
            return false
        }
    }
}
