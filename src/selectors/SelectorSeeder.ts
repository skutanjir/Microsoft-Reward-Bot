/**
 * Selector Seeder
 * Populates the SelectorBank with initial known selectors
 */

import { SelectorBank } from './SelectorBank'
import type { UIContext } from '../types'

export class SelectorSeeder {
    static seed(bank: SelectorBank): void {
        // Initial desktop context (default)
        const desktopContext: UIContext = {
            pageUrl: 'https://rewards.bing.com/earn/',
            collapsed: false,
            tier: 'member',
            mobile: false
        }

        // Initial mobile context
        const mobileContext: UIContext = {
            pageUrl: 'https://rewards.bing.com/earn/',
            collapsed: false,
            tier: 'member',
            mobile: true
        }

        // --- 2025 UI Landmarks ---
        bank.addCandidate('section_header', 'class', '.mai:text-sectionHeader', desktopContext, 90)
        bank.addCandidate('disclosure_button', 'class', '.react-aria-Disclosure', desktopContext, 85)

        // --- Section Containers (Daily Set, Streaks, Keep Earning) ---
        bank.addCandidate('daily_set_container', 'css', 'button[aria-label*="Daily set" i][slot="trigger"]', desktopContext, 99)
        bank.addCandidate('daily_set_container', 'css', 'button[aria-label*="Daily set" i]', desktopContext, 98)
        bank.addCandidate('daily_set_container', 'text', 'See more tasks', desktopContext, 95)
        bank.addCandidate('daily_set_container', 'text', 'Daily set', desktopContext, 90)

        bank.addCandidate('keep_earning_container', 'css', 'button[aria-label*="Keep earning" i][slot="trigger"]', desktopContext, 99)
        bank.addCandidate('keep_earning_container', 'css', 'button[aria-label*="Keep earning" i]', desktopContext, 98)
        bank.addCandidate('keep_earning_container', 'text', 'See more tasks', desktopContext, 95)
        bank.addCandidate('keep_earning_container', 'text', 'More activities', desktopContext, 92)
        bank.addCandidate('keep_earning_container', 'aria', 'Keep earning', desktopContext, 90)

        bank.addCandidate('streaks_container', 'css', 'button[aria-label*="Streaks" i]', desktopContext, 98)
        bank.addCandidate('streaks_container', 'text', 'Streaks', desktopContext, 90)
        bank.addCandidate('activity_card', 'aria', '[data-bi-id*="offer"]', desktopContext, 95)
        bank.addCandidate('activity_card', 'aria', '[data-bi-id*="item"]', desktopContext, 92)
        bank.addCandidate('activity_card', 'class', 'bg-neutralBg1.cursor-pointer', desktopContext, 90)
        bank.addCandidate('activity_card', 'class', 'card-content', desktopContext, 85)
        bank.addCandidate('activity_card', 'class', 'cursor-pointer', desktopContext, 50) // Lowered significantly as it's too broad

        // --- Specific Element Selectors ---
        bank.addCandidate('points_value', 'class', '.text-title1', desktopContext, 95)

        bank.addCandidate('checkmark', 'class', 'brandStrokeCompound', desktopContext, 90)
        bank.addCandidate('checkmark', 'aria', '[aria-label*="Complete"]', desktopContext, 80)

        // --- Mobile Specifics ---
        bank.addCandidate('activity_card', 'class', '.mobileCard', mobileContext, 90)
    }
}
