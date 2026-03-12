/**
 * Task Manager
 * Orchestrates execution of discovered tasks using specialized handlers.
 */

import type { Page } from 'patchright'
import { Logger } from '../logging/Logger'
import { SelectorResolver } from '../selectors/SelectorResolver'
import { UrlRewardHandler } from '../activities/UrlRewardHandler'
import { BaseActivityHandler } from '../activities/BaseActivityHandler'
import type { DiscoveredTask, UIContext, TaskType } from '../types'

export class TaskManager {
    private logger: Logger
    private handlers: Map<TaskType, BaseActivityHandler>

    constructor(logger: Logger, selectorResolver: SelectorResolver) {
        this.logger = logger
        this.handlers = new Map()
        this.registerHandler(new UrlRewardHandler(logger, selectorResolver))
    }

    private registerHandler(handler: BaseActivityHandler): void {
        this.handlers.set(handler.getType(), handler)
    }

    async executeTasks(page: Page, tasks: DiscoveredTask[], uiContext: UIContext): Promise<void> {
        const pending = tasks.filter(t => !t.isComplete && !t.isLocked)
        this.logger.info('TASK_MANAGER', `Executing ${pending.length}/${tasks.length} pending tasks`)

        // Sort by vertical position to avoid jumping around
        const sorted = [...pending].sort((a, b) => a.y - b.y)

        for (const task of sorted) {
            try {
                await this.executeTask(page, task, uiContext)
                await new Promise(r => setTimeout(r, 2500 + Math.random() * 1500))
            } catch (error) {
                this.logger.error('TASK_MANAGER', `Failed: "${task.title}"`, {
                    error: error instanceof Error ? error.message : String(error)
                })
            }
        }

        this.logger.info('TASK_MANAGER', 'Task execution complete')
    }

    private async executeTask(page: Page, task: DiscoveredTask, uiContext: UIContext): Promise<void> {
        const type = this.determineTaskType(task)
        const handler = this.handlers.get(type) ?? this.handlers.get('url_reward')!

        this.logger.info('TASK_MANAGER', `[${type}] Executing: "${task.title}"`)
        const success = await handler.handle(page, task, uiContext)

        if (success) {
            this.logger.info('TASK_MANAGER', `✓ Completed: "${task.title}"`)
        } else {
            this.logger.warn('TASK_MANAGER', `✗ Failed: "${task.title}"`)
        }
    }

    private determineTaskType(task: DiscoveredTask): TaskType {
        if (task.typeHints.includes('quiz')) return 'quiz'
        if (task.typeHints.includes('poll')) return 'poll'
        if (task.destinationUrl?.includes('pollscenarioid')) return 'poll'
        return 'url_reward'
    }
}