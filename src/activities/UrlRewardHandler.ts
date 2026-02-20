import type { Page } from 'patchright'
import { BaseActivityHandler } from './BaseActivityHandler'
import type { DiscoveredTask, UIContext, TaskType } from '../types'

export class UrlRewardHandler extends BaseActivityHandler {
    getType(): TaskType {
        return 'url_reward'
    }

    async handle(page: Page, task: DiscoveredTask, _uiContext: UIContext): Promise<boolean> {
        this.logger.info('ACTIVITY', `Handling URL Reward: ${task.title}`)
        return await this.clickAndWait(page, task)
    }
}
