/**
 * Session Manager
 * Manages browser sessions, cookies, and authentication state
 */

import fs from 'fs'
import path from 'path'
import type { BrowserContext } from 'patchright'
import type { Account } from '../types'
import { Logger } from '../logging/Logger'

export class SessionManager {
    private logger: Logger
    private sessionPath: string

    constructor(logger: Logger, sessionPath: string) {
        this.logger = logger
        this.sessionPath = sessionPath

        // Ensure session directory exists
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true })
        }
    }

    /**
     * Get session file path for account
     */
    private getSessionFile(account: Account, isMobile: boolean): string {
        const sanitized = account.email.replace(/[^a-z0-9]/gi, '_')
        const suffix = isMobile ? '_mobile' : '_desktop'
        return path.join(this.sessionPath, `${sanitized}${suffix}.json`)
    }

    /**
     * Save session (cookies + storage) to file
     */
    async saveSession(account: Account, context: BrowserContext, isMobile: boolean): Promise<void> {
        const cookies = await context.cookies()
        const sessionFile = this.getSessionFile(account, isMobile)

        // Get storage from not just the context, but we need a page to access local/session storage
        // Since we might not have a page handy in this method signature often, we primarily rely on cookies 
        // effectively, but let's try to grab storage if we can from the first page if it exists
        let localStorageData: Array<{ origin: string, key: string, value: string }> = []
        let sessionStorageData: Array<{ origin: string, key: string, value: string }> = []

        if (context.pages().length > 0) {
            const page = context.pages()[0]
            try {
                const storage = await page.evaluate(() => {
                    const local: Array<{ origin: string, key: string, value: string }> = []
                    const session: Array<{ origin: string, key: string, value: string }> = []

                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i)
                        if (key) local.push({ origin: window.location.origin, key, value: localStorage.getItem(key) || '' })
                    }

                    for (let i = 0; i < sessionStorage.length; i++) {
                        const key = sessionStorage.key(i)
                        if (key) session.push({ origin: window.location.origin, key, value: sessionStorage.getItem(key) || '' })
                    }
                    return { local, session }
                })
                localStorageData = storage.local
                sessionStorageData = storage.session
            } catch (e) {
                // Ignore if we can't get storage (e.g. if page is closed or not ready)
            }
        }

        const sessionData = {
            email: account.email,
            mobile: isMobile,
            cookies,
            localStorage: localStorageData,
            sessionStorage: sessionStorageData,
            savedAt: new Date().toISOString()
        }

        fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2))
        this.logger.debug('SESSION', `Saved session used ${cookies.length} cookies, ${localStorageData.length} local items for ${account.email}`)
    }

    /**
     * Restore session (cookies + storage)
     */
    async restoreSession(account: Account, context: BrowserContext, isMobile: boolean): Promise<boolean> {
        const sessionFile = this.getSessionFile(account, isMobile)

        if (!fs.existsSync(sessionFile)) {
            return false
        }

        try {
            const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))

            if (sessionData.cookies && sessionData.cookies.length > 0) {
                await context.addCookies(sessionData.cookies)
            }

            // Restore storage if we have any and if there's a page
            // Note: Storage often needs to be set ON the specific origin. 
            // We can't just "set storage" globally like cookies.
            // This is a limitation. We typically rely on cookies for main auth.
            // However, we can inject an init script to restore it on next navigation
            if (sessionData.localStorage && sessionData.localStorage.length > 0) {
                await context.addInitScript((storageData: any) => {
                    if (window.location.origin === 'https://rewards.bing.com' ||
                        window.location.origin === 'https://login.live.com') {
                        storageData.forEach((item: any) => {
                            if (item.origin === window.location.origin) {
                                localStorage.setItem(item.key, item.value)
                            }
                        })
                    }
                }, sessionData.localStorage)
            }

            this.logger.info('SESSION', `Restored session for ${account.email}`)
            return true
        } catch (error) {
            this.logger.warn('SESSION', `Failed to restore session: ${error}`)
            return false
        }
    }

    /**
     * Check if session exists and is valid
     */
    hasValidSession(account: Account, isMobile: boolean): boolean {
        const sessionFile = this.getSessionFile(account, isMobile)

        if (!fs.existsSync(sessionFile)) {
            return false
        }

        try {
            const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))
            const savedAt = new Date(sessionData.savedAt)
            const ageHours = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60)

            // Consider session invalid if older than 24 hours
            if (ageHours > 24) {
                this.logger.debug('SESSION', `Session expired for ${account.email} (${ageHours.toFixed(1)}h old)`)
                return false
            }

            return sessionData.cookies.length > 0
        } catch {
            return false
        }
    }

    /**
     * Clear session for account
     */
    clearSession(account: Account, isMobile: boolean): void {
        const sessionFile = this.getSessionFile(account, isMobile)

        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile)
            this.logger.info('SESSION', `Cleared session for ${account.email} (mobile: ${isMobile})`)
        }
    }
}
