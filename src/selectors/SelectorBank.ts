/**
 * Selector Bank
 * Manages in-memory cache of selector candidates and handles evolution
 */

import { SelectorPersistence } from './SelectorPersistence'
import type { SelectorCandidate, UIContext, SelectorStrategy } from '../types'
import { Logger } from '../logging/Logger'
// I'll use a simple random string if uuid is not available

export class SelectorBank {
    private logger: Logger
    private persistence: SelectorPersistence
    private selectors: Map<string, SelectorCandidate[]> = new Map() // elementType -> candidates

    constructor(logger: Logger, persistence: SelectorPersistence) {
        this.logger = logger
        this.persistence = persistence
        this.loadSelectors()
    }

    /**
     * Load selectors from database into memory cache
     */
    private loadSelectors(): void {
        const all = this.persistence.loadAllSelectors()
        for (const selector of all) {
            const existing = this.selectors.get(selector.elementType) || []
            existing.push(selector)
            this.selectors.set(selector.elementType, existing)
        }
        this.logger.debug('SELECTORS', `Loaded ${all.length} selectors into memory cache`)
    }

    /**
     * Get ranked candidates for a specific element type and UI context
     */
    getCandidates(elementType: string, uiContext: UIContext): SelectorCandidate[] {
        const candidates = this.selectors.get(elementType) || []

        // Filter by context and rank by confidence
        return candidates
            .filter(c =>
                c.uiContext.mobile === uiContext.mobile &&
                c.retiredAt === null
            )
            .sort((a, b) => b.confidence - a.confidence)
    }

    /**
     * Register a new selector candidate
     */
    addCandidate(
        elementType: string,
        strategy: SelectorStrategy,
        value: string,
        uiContext: UIContext,
        confidence: number = 50
    ): SelectorCandidate {
        const candidate: SelectorCandidate = {
            id: Math.random().toString(36).substring(2, 15),
            elementType,
            selectorStrategy: strategy,
            selectorValue: value,
            confidence,
            successCount: 0,
            failureCount: 0,
            lastSuccess: null,
            lastFailure: null,
            avgResponseTime: 0,
            uiContext: { ...uiContext },
            generatedAt: new Date(),
            retiredAt: null
        }

        const existing = this.selectors.get(elementType) || []
        existing.push(candidate)
        this.selectors.set(elementType, existing)

        this.persistence.saveSelector(candidate)
        return candidate
    }

    /**
     * Promote a selector after a successful interaction
     */
    promoteSelector(id: string, responseTime: number): void {
        this.persistence.recordInteraction(id, 'success', responseTime)
        this.updateMemoryCache(id, 'success', responseTime)
    }

    /**
     * Degrade a selector after a failed interaction
     */
    degradeSelector(id: string): void {
        this.persistence.recordInteraction(id, 'failure', 0)
        this.updateMemoryCache(id, 'failure', 0)
    }

    /**
     * Update the in-memory cache after an interaction
     */
    private updateMemoryCache(id: string, action: 'success' | 'failure', responseTime: number): void {
        for (const [_, candidates] of this.selectors) {
            const selector = candidates.find(c => c.id === id)
            if (selector) {
                if (action === 'success') {
                    selector.successCount++
                    selector.lastSuccess = new Date()
                    selector.confidence = Math.min(100, selector.confidence + 5)
                    selector.avgResponseTime = (selector.avgResponseTime * (selector.successCount - 1) + responseTime) / selector.successCount
                } else {
                    selector.failureCount++
                    selector.lastFailure = new Date()
                    selector.confidence = Math.max(0, selector.confidence - 10)

                    // Auto-retire if too many failures
                    if (selector.confidence < 10 && selector.failureCount > 5) {
                        selector.retiredAt = new Date()
                        this.persistence.saveSelector(selector)
                        this.logger.warn('SELECTORS', `Retired failed selector: ${selector.selectorValue}`)
                    }
                }
                break
            }
        }
    }

    /**
     * Clear all (useful for reset/testing)
     */
    clear(): void {
        this.selectors.clear()
    }
}
