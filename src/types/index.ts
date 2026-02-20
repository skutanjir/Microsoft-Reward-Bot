/**
 * Core type definitions and interfaces for the Microsoft Rewards Automation Platform
 */

import type { BrowserContext, Cookie, Page } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

// ============================================================================
// Account & Authentication
// ============================================================================

export interface Account {
    email: string
    password: string
    proxy?: ProxyConfig
    enabled?: boolean
    disabled?: boolean
}

export interface ProxyConfig {
    protocol: 'http' | 'https' | 'socks4' | 'socks5'
    host: string
    port: number
    username?: string
    password?: string
}

// ============================================================================
// Configuration
// ============================================================================

export interface BotConfig {
    accounts: Account[]
    sessionPath: string
    headless: boolean
    workers: number
    searchSettings: SearchSettings
    selectorLearning: SelectorLearningConfig
    antiDetection: AntiDetectionConfig
    recovery: RecoveryConfig
    dashboard: DashboardConfig
    webhooks: WebhookConfig
    baseURL: string
    maxAccounts?: number
    speedSettings?: SpeedSettings
}

export interface SpeedSettings {
    minDelay: number
    maxDelay: number
}

export interface SearchSettings {
    desktopSearches: number
    mobileSearches: number
    searchOrder: 'desktop-first' | 'mobile-first'
    retryMobileSearchAmount: number
}

export interface SelectorLearningConfig {
    enabled: boolean
    persistencePath: string
    autoMutate: boolean
    trainingMode: boolean
    confidenceThreshold: number
}

export interface AntiDetectionConfig {
    timingProfile: 'conservative' | 'normal' | 'aggressive'
    enableMouseMovement: boolean
    enableScrollVariation: boolean
    enableHoverBehavior: boolean
}

export interface RecoveryConfig {
    maxRetries: number
    enableAutoRecovery: boolean
    fallbackToManual: boolean
}

export interface DashboardConfig {
    enabled: boolean
    port: number
    auth: {
        username: string
        password: string
    }
}

export interface WebhookConfig {
    enabled: boolean
    discordWebhookUrl?: string
}

// ============================================================================
// Browser & Session
// ============================================================================

export interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
    cookies: {
        desktop: Cookie[]
        mobile: Cookie[]
    }
}

export interface ExecutionContext {
    account: Account
    isMobile: boolean
    sessionStart: Date
    initialPoints: number
    currentPoints: number
}

// ============================================================================
// Page Context & Navigation
// ============================================================================

export type PageType = 'dashboard' | 'earn' | 'unknown'
export type UIVersion = 'legacy' | 'new_2025' | 'unknown'
export type AccountTier = 'member' | 'silver' | 'gold'

export interface SectionState {
    exists: boolean
    expanded: boolean
    loaded: boolean
}

export interface PageContext {
    page: PageType
    uiVersion: UIVersion
    sections: {
        dailySet: SectionState
        keepEarning: SectionState
        streaks?: SectionState
        quests?: SectionState
    }
    tier: AccountTier
    mobile: boolean
}

// ============================================================================
// Selector Intelligence
// ============================================================================

export type SelectorStrategy = 'aria' | 'text' | 'structure' | 'class' | 'hybrid' | 'css' | 'id'

export interface SelectorCandidate {
    id: string
    elementType: string
    selectorStrategy: SelectorStrategy
    selectorValue: string
    confidence: number
    successCount: number
    failureCount: number
    lastSuccess: Date | null
    lastFailure: Date | null
    avgResponseTime: number
    uiContext: {
        pageUrl: string
        collapsed: boolean
        tier: AccountTier
        mobile: boolean
    }
    generatedAt: Date
    retiredAt: Date | null
}

export interface UIContext {
    pageUrl: string
    collapsed: boolean
    tier: AccountTier
    mobile: boolean
}

// ============================================================================
// Task Management
// ============================================================================

export enum TaskState {
    DISCOVERED = 'discovered',
    AVAILABLE = 'available',
    IN_PROGRESS = 'in_progress',
    VALIDATING = 'validating',
    COMPLETED = 'completed',
    SKIPPED = 'skipped',
    FAILED = 'failed',
    INVALID = 'invalid'
}

export type TaskType =
    | 'quiz'
    | 'poll'
    | 'abc'
    | 'this_or_that'
    | 'url_reward'
    | 'search_task'
    | 'find_clippy'
    | 'daily_checkin'
    | 'read_to_earn'
    | 'unknown'

export interface DiscoveredTask {
    id: string
    title: string
    points: number
    isComplete: boolean
    isLocked: boolean
    lockReason?: string
    typeHints: string[]
    actionTarget: any // ElementHandle
    destinationUrl?: string
    y: number // Vertical position for sorting
    containerElement: any // ElementHandle
}

export interface ParsedTask extends DiscoveredTask {
    type: TaskType
    offerId?: string
    promotionType?: string
}

export interface Task extends ParsedTask {
    state: TaskState
    attempts: number
    errors: string[]
    startTime?: Date
    endTime?: Date
    pointsEarned: number
}

export interface TaskStateTransition {
    taskId: string
    fromState: TaskState
    toState: TaskState
    timestamp: Date
    trigger: string
    metadata: Record<string, any>
}

// ============================================================================
// Dashboard Data (from TheNetsky)
// ============================================================================

export interface DashboardData {
    userStatus: {
        availablePoints: number
        counters: Counters
    }
    dailySetPromotions: Record<string, BasePromotion[]>
    morePromotions?: BasePromotion[]
    morePromotionsWithoutPromotionalItems?: BasePromotion[]
    promotionalItems?: PurplePromotionalItem[]
}

export interface Counters {
    pcSearch?: Array<{
        pointProgress: number
        pointProgressMax: number
    }>
    mobileSearch?: Array<{
        pointProgress: number
        pointProgressMax: number
    }>
}

export interface BasePromotion {
    offerId: string
    title: string
    name?: string
    promotionType?: string
    destinationUrl?: string
    complete: boolean
    pointProgressMax: number
    pointProgress: number
    activityProgressMax?: number
    activityType?: string
    hash: string
    exclusiveLockedFeatureStatus?: 'locked' | 'unlocked'
}

export interface PurplePromotionalItem extends BasePromotion {
    // Extended fields for special promotions
}

// ============================================================================
// Error & Recovery
// ============================================================================

export enum FailureType {
    SELECTOR_NOT_FOUND = 'selector_not_found',
    ELEMENT_NOT_CLICKABLE = 'element_not_clickable',
    NAVIGATION_FAILED = 'navigation_failed',
    LAZY_LOAD_TIMEOUT = 'lazy_load_timeout',
    PARTIAL_RENDER = 'partial_render',
    HEADLESS_DETECTION = 'headless_detection',
    NETWORK_ERROR = 'network_error',
    SESSION_EXPIRED = 'session_expired',
    TASK_STATE_MISMATCH = 'task_state_mismatch'
}

export interface FailureContext {
    type: FailureType
    message: string
    task?: Task
    page?: Page
    context?: any
    timestamp: Date
}

export interface RecoveryResult {
    success: boolean
    message: string
    action: string
}

export interface RecoveryStrategy {
    maxRetries: number
    backoffMs: number[]
    recovery: (context: FailureContext) => Promise<RecoveryResult>
}

// ============================================================================
// Anti-Detection
// ============================================================================

export interface TimingProfile {
    actionDelay: { min: number; max: number; distribution: 'normal' | 'exponential' }
    mouseMovementSpeed: { min: number; max: number }
    typingSpeed: { min: number; max: number; variance: number }
    scrollSpeed: { min: number; max: number }
    pageLoadWait: { min: number; max: number }
    decisionLatency: { min: number; max: number }
}

// ============================================================================
// Logging & Monitoring
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical'

export interface LogEntry {
    timestamp: Date
    level: LogLevel
    context: string
    message: string
    data?: any
    account?: string
    mobile?: boolean
}

// ============================================================================
// Statistics & Reporting
// ============================================================================

export interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
    tasksCompleted: number
    tasksFailed: number
}

export interface ExecutionSummary {
    startTime: Date
    endTime: Date
    totalAccounts: number
    successfulAccounts: number
    failedAccounts: number
    totalPointsEarned: number
    stats: AccountStats[]
}
