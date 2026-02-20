/**
 * Selector Resolver
 * Runtime element resolution using the Selector Bank
 */

import type { Page, ElementHandle } from 'patchright'
import { SelectorBank } from './SelectorBank'
import type { UIContext } from '../types'
import { Logger } from '../logging/Logger'

export class SelectorResolver {
    private logger: Logger
    private selectorBank: SelectorBank

    constructor(logger: Logger, selectorBank: SelectorBank) {
        this.logger = logger
        this.selectorBank = selectorBank
    }

    /**
     * Normalize selector based on strategy
     */
    private normalizeSelector(candidate: any): string {
        switch (candidate.selectorStrategy) {
            case 'text':
                return `text="${candidate.selectorValue}"`
            case 'class':
                // Auto-prefix with dot if not present
                return candidate.selectorValue.startsWith('.') ? candidate.selectorValue : `.${candidate.selectorValue}`
            case 'id':
                return candidate.selectorValue.startsWith('#') ? candidate.selectorValue : `#${candidate.selectorValue}`
            default:
                return candidate.selectorValue
        }
    }

    /**
     * Resolve an element on the page using multiple candidates from the bank
     */
    async resolveElement(
        page: Page,
        elementType: string,
        uiContext: UIContext,
        timeout: number = 5000
    ): Promise<ElementHandle | null> {
        const candidates = this.selectorBank.getCandidates(elementType, uiContext)

        if (candidates.length === 0) {
            this.logger.warn('RESOLVER', `No candidates found for element type: ${elementType}`)
            return null
        }

        this.logger.debug('RESOLVER', `Trying ${candidates.length} candidates for ${elementType}`)

        const startTime = Date.now()

        for (const candidate of candidates) {
            const selector = this.normalizeSelector(candidate)
            try {
                const element = await page.waitForSelector(selector, {
                    timeout,
                    state: 'attached'
                })

                if (element) {
                    const responseTime = Date.now() - startTime
                    this.logger.debug('RESOLVER', `Successfully resolved ${elementType} using: ${selector} (${responseTime}ms)`)
                    this.selectorBank.promoteSelector(candidate.id, responseTime)
                    return element
                }
            } catch (e) {
                this.selectorBank.degradeSelector(candidate.id)
                this.logger.debug('RESOLVER', `Candidate failed: ${selector}`)
            }
        }

        return null
    }

    async resolveElements(
        page: Page,
        elementType: string,
        uiContext: UIContext
    ): Promise<ElementHandle[]> {
        const candidates = this.selectorBank.getCandidates(elementType, uiContext)

        for (const candidate of candidates) {
            const selector = this.normalizeSelector(candidate)
            const elements = await page.$$(selector)
            if (elements.length > 0) {
                this.selectorBank.promoteSelector(candidate.id, 0)
                return elements
            }
        }

        return []
    }
}
