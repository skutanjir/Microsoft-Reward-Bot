/**
 * Utility Functions
 * Common helpers for timing, randomization, date formatting, and waits
 */

export class Utils {
    /**
     * Generate random delay with variance
     */
    randomDelay(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    /**
     * Wait for specified duration with optional variance
     */
    async wait(duration: number, variance: number = 0): Promise<void> {
        const actualDuration = variance > 0 ? this.randomDelay(duration - variance, duration + variance) : duration
        return new Promise(resolve => setTimeout(resolve, actualDuration))
    }

    /**
     * Get formatted date string for today (YYYY-MM-DD)
     */
    getFormattedDate(date: Date = new Date()): string {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        return `${year}-${month}-${day}`
    }

    /**
     * Parse ms duration string (e.g., '5s', '2m', '1h')
     */
    parseDuration(duration: string): number {
        // Simple duration parsing without ms library
        const regex = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i
        const match = duration.match(regex)

        if (!match) {
            throw new Error(`Invalid duration format: ${duration}`)
        }

        const value = parseFloat(match[1])
        const unit = (match[2] || 'ms').toLowerCase()

        switch (unit) {
            case 'ms':
                return value
            case 's':
                return value * 1000
            case 'm':
                return value * 60 * 1000
            case 'h':
                return value * 60 * 60 * 1000
            case 'd':
                return value * 24 * 60 * 60 * 1000
            default:
                return value
        }
    }

    /**
     * Format duration in ms to human-readable string
     */
    formatDuration(durationMs: number): string {
        if (durationMs < 1000) {
            return `${durationMs}ms`
        }

        const seconds = Math.floor(durationMs / 1000)
        if (seconds < 60) {
            return `${seconds}s`
        }

        const minutes = Math.floor(seconds / 60)
        const remainingSeconds = seconds % 60
        if (minutes < 60) {
            return `${minutes}m ${remainingSeconds}s`
        }

        const hours = Math.floor(minutes / 60)
        const remainingMinutes = minutes % 60
        return `${hours}h ${remainingMinutes}m`
    }

    /**
     * Calculate exponential backoff delay
     */
    calculateBackoff(attempt: number, baseDelay: number = 1000, maxDelay: number = 30000): number {
        const exponential = baseDelay * Math.pow(2, attempt)
        const jitter = Math.random() * 0.3 * exponential
        return Math.min(exponential + jitter, maxDelay)
    }

    /**
     * Retry an async function with exponential backoff
     */
    async retryWithBackoff<T>(
        fn: () => Promise<T>,
        maxRetries: number = 3,
        baseDelay: number = 1000
    ): Promise<T> {
        let lastError: Error

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await fn()
            } catch (error) {
                lastError = error as Error

                if (attempt < maxRetries - 1) {
                    const delay = this.calculateBackoff(attempt, baseDelay)
                    await this.wait(delay)
                }
            }
        }

        throw lastError!
    }

    /**
     * Shuffle array
     */
    shuffleArray<T>(array: T[]): T[] {
        const shuffled = [...array]
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
        }
        return shuffled
    }

    /**
     * Generate random integer between min and max (inclusive)
     */
    randomInt(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    /**
     * Generate random boolean with optional probability
     */
    randomBoolean(probability: number = 0.5): boolean {
        return Math.random() < probability
    }

    /**
     * Clamp value between min and max
     */
    clamp(value: number, min: number, max: number): number {
        return Math.min(Math.max(value, min), max)
    }

    /**
     * Sleep for duration specified as string (e.g., '5s', '2m')
     */
    async sleep(duration: string): Promise<void> {
        const ms = this.parseDuration(duration)
        await this.wait(ms)
    }

    /**
     * Estimate reading time based on text length (in ms)
     * Assumes average reading speed of 200 words per minute
     */
    estimateReadingTime(text: string): number {
        const wordCount = text.split(/\s+/).length
        const wordsPerMinute = 200
        const minutes = wordCount / wordsPerMinute
        return Math.ceil(minutes * 60 * 1000)
    }

    /**
     * Generate UUID v4
     */
    generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0
            const v = c === 'x' ? r : (r & 0x3) | 0x8
            return v.toString(16)
        })
    }

    /**
     * Check if date is today
     */
    isToday(date: Date): boolean {
        const today = new Date()
        return (
            date.getDate() === today.getDate() &&
            date.getMonth() === today.getMonth() &&
            date.getFullYear() === today.getFullYear()
        )
    }

    /**
     * Get days between two dates
     */
    daysBetween(date1: Date, date2: Date): number {
        const diffTime = Math.abs(date2.getTime() - date1.getTime())
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24))
    }

    /**
     * Sanitize filename
     */
    sanitizeFilename(filename: string): string {
        return filename.replace(/[^a-z0-9_\-\.]/gi, '_').toLowerCase()
    }

    /**
     * Truncate string with ellipsis
     */
    truncate(str: string, maxLength: number): string {
        if (str.length <= maxLength) return str
        return str.substring(0, maxLength - 3) + '...'
    }
}

// Global utils instance
export const utils = new Utils()
