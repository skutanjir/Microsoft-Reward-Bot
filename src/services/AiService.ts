import axios from 'axios';
import { Logger } from '../logging/Logger';

export interface AiMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    reasoning_details?: string;
}

export class AiService {
    private apiKey: string;
    private model: string;
    private logger: Logger;
    private baseUrl = 'https://openrouter.ai/api/v1/chat/completions';

    constructor(logger: Logger) {
        this.logger = logger;
        this.apiKey = process.env.OPENROUTER_API_KEY || '';
        this.model = process.env.AI_MODEL || 'arcee-ai/trinity-large-preview:free';

        if (!this.apiKey) {
            this.logger.warn('AI-SERVICE', 'OPENROUTER_API_KEY is missing. AI features will be disabled.');
        }
    }

    /**
     * Get a completion from the AI model
     */
    async getCompletion(messages: AiMessage[], useReasoning = true): Promise<AiMessage | null> {
        if (!this.apiKey) return null;

        try {
            this.logger.debug('AI-SERVICE', `Requesting completion from model: ${this.model}`);

            const response = await axios.post(
                this.baseUrl,
                {
                    model: this.model,
                    messages: messages,
                    reasoning: useReasoning ? { enabled: true } : undefined
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const result = response.data;
            if (result.choices && result.choices.length > 0) {
                const message = result.choices[0].message;

                if (message.reasoning_details && process.env.AI_REASONING === 'true') {
                    this.logger.debug('AI-SERVICE', 'AI Reasoning Details received');
                }

                return {
                    role: 'assistant',
                    content: message.content,
                    reasoning_details: message.reasoning_details
                };
            }

            return null;
        } catch (error) {
            this.logger.error('AI-SERVICE', `AI Request failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /**
     * Analyze a page snippet to find an element
     */
    async findElement(pageDescription: string, goal: string): Promise<{ selector?: string; action?: string; confidence: number } | null> {
        const prompt = `
            You are an expert web automation assistant. Given a description of a web page's structure (or a simplified HTML snippet) and a goal, identify the best CSS selector or action to take.
            
            Page Description:
            ${pageDescription}
            
            Goal: ${goal}
            
            Return ONLY a valid JSON object with the following keys:
            - selector: the CSS selector for the element (if applicable)
            - action: a specific instruction if a selector isn't enough (e.g., "scroll and search")
            - confidence: a number between 0 and 1
        `;

        const response = await this.getCompletion([
            { role: 'system', content: 'You identify UI elements and actions for automation. Reply ONLY with JSON.' },
            { role: 'user', content: prompt }
        ]);

        if (!response) return null;

        try {
            // Extract JSON if AI wrapped it in markdown
            const jsonStr = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(jsonStr);
        } catch (e) {
            this.logger.error('AI-SERVICE', 'Failed to parse AI JSON response');
            return null;
        }
    }
}
