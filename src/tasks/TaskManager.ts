/**
 * Task Manager
 * Orchestrates the execution of discovered tasks using specialized handlers
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

        // Register handlers
        this.registerHandler(new UrlRewardHandler(logger, selectorResolver))
        // More handlers (Quiz, Poll, etc.) will be added here
    }

    private registerHandler(handler: BaseActivityHandler): void {
        this.handlers.set(handler.getType(), handler)
    }

    /**
     * Execute a list of discovered tasks
     */
    async executeTasks(page: Page, tasks: DiscoveredTask[], uiContext: UIContext): Promise<void> {
        this.logger.info('TASK_MANAGER', `Starting execution for ${tasks.length} tasks...`)

        // Sort tasks by Y position to prevent jumping around "up and down"
        const sortedTasks = [...tasks].sort((a, b) => a.y - b.y)

        for (const task of sortedTasks) {
            try {
                await this.executeTask(page, task, uiContext)
                // Add a human-like delay between tasks
                await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000))
            } catch (error) {
                this.logger.error('TASK_MANAGER', `Failed to execute task: ${task.title}`, { error: error instanceof Error ? error.message : String(error) })
            }
        }

        this.logger.info('TASK_MANAGER', 'Task execution phase complete.')
    }

    /**
     * Execute a single task
     */
    private async executeTask(page: Page, task: DiscoveredTask, uiContext: UIContext): Promise<void> {
        // Determine task type (for now we default to url_reward if not specific)
        const type: TaskType = this.determineTaskType(task)
        const handler = this.handlers.get(type) || this.handlers.get('url_reward')

        if (handler) {
            this.logger.info('TASK_MANAGER', `Executing ${type} handler for: ${task.title}`)
            const success = await handler.handle(page, task, uiContext)

            if (success) {
                this.logger.info('TASK_MANAGER', `Successfully completed task: ${task.title}`)
            } else {
                this.logger.warn('TASK_MANAGER', `Handler reported failure for task: ${task.title}`)
            }
        } else {
            this.logger.warn('TASK_MANAGER', `No handler found for task type: ${type}`)
        }
    }

    /**
     * Determine the task type based on hints and metadata
     */
    private determineTaskType(task: DiscoveredTask): TaskType {
        if (task.typeHints.includes('quiz')) return 'quiz'
        if (task.typeHints.includes('poll')) return 'poll'
        if (task.destinationUrl?.includes('pollscenarioid')) return 'poll'

        return 'url_reward'
    }
}
