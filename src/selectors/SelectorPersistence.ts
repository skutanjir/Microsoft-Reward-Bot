/**
 * Selector Persistence Layer
 * Handles SQLite storage for selector candidates and history
 */

import Database from 'better-sqlite3'
import type { SelectorCandidate, SelectorStrategy } from '../types'
import { Logger } from '../logging/Logger'

export class SelectorPersistence {
    private db: Database.Database
    private logger: Logger

    constructor(logger: Logger, dbPath: string) {
        this.logger = logger
        this.db = new Database(dbPath)
        this.initialize()
    }

    /**
     * Initialize database schema
     */
    private initialize(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS selectors (
        id TEXT PRIMARY KEY,
        element_type TEXT NOT NULL,
        strategy TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        last_success TEXT,
        last_failure TEXT,
        avg_response_time REAL DEFAULT 0,
        ui_context_json TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        retired_at TEXT
      );

      CREATE TABLE IF NOT EXISTS selector_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        selector_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        response_time REAL,
        error_message TEXT,
        FOREIGN KEY (selector_id) REFERENCES selectors(id)
      );

      CREATE INDEX IF NOT EXISTS idx_element_type ON selectors (element_type);
      CREATE INDEX IF NOT EXISTS idx_confidence ON selectors (confidence DESC);
    `)
        this.logger.debug('SELECTORS', 'Selector database initialized')
    }

    /**
     * Save or update a selector candidate
     */
    saveSelector(candidate: SelectorCandidate): void {
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO selectors (
        id, element_type, strategy, value, confidence, 
        success_count, failure_count, last_success, last_failure, 
        avg_response_time, ui_context_json, generated_at, retired_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

        stmt.run(
            candidate.id,
            candidate.elementType,
            candidate.selectorStrategy,
            candidate.selectorValue,
            candidate.confidence,
            candidate.successCount,
            candidate.failureCount,
            candidate.lastSuccess?.toISOString() || null,
            candidate.lastFailure?.toISOString() || null,
            candidate.avgResponseTime,
            JSON.stringify(candidate.uiContext),
            candidate.generatedAt.toISOString(),
            candidate.retiredAt?.toISOString() || null
        )
    }

    /**
     * Load all active selectors
     */
    loadAllSelectors(): SelectorCandidate[] {
        const rows = this.db.prepare('SELECT * FROM selectors WHERE retired_at IS NULL').all()

        return rows.map((row: any) => ({
            id: row.id,
            elementType: row.element_type,
            selectorStrategy: row.strategy as SelectorStrategy,
            selectorValue: row.value,
            confidence: row.confidence,
            successCount: row.success_count,
            failureCount: row.failure_count,
            lastSuccess: row.last_success ? new Date(row.last_success) : null,
            lastFailure: row.last_failure ? new Date(row.last_failure) : null,
            avgResponseTime: row.avg_response_time,
            uiContext: JSON.parse(row.ui_context_json),
            generatedAt: new Date(row.generated_at),
            retiredAt: row.retired_at ? new Date(row.retired_at) : null
        }))
    }

    /**
     * Record a success or failure for a selector
     */
    recordInteraction(selectorId: string, action: 'success' | 'failure', responseTime: number, error?: string): void {
        const timestamp = new Date().toISOString()

        // Add to history
        this.db.prepare(`
      INSERT INTO selector_history (selector_id, timestamp, action, response_time, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).run(selectorId, timestamp, action, responseTime, error || null)

        // Update main record
        if (action === 'success') {
            this.db.prepare(`
        UPDATE selectors 
        SET success_count = success_count + 1, 
            last_success = ?,
            avg_response_time = (avg_response_time * success_count + ?) / (success_count + 1)
        WHERE id = ?
      `).run(timestamp, responseTime, selectorId)
        } else {
            this.db.prepare(`
        UPDATE selectors 
        SET failure_count = failure_count + 1, 
            last_failure = ?
        WHERE id = ?
      `).run(timestamp, selectorId)
        }
    }

    /**
     * Close database connection
     */
    close(): void {
        this.db.close()
    }
}
