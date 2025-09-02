import OpenAI from 'openai';
import { 
  Logger, 
  Review, 
  DatabasePool, 
  getDatabasePool 
} from '@review-scraper/shared';

/**
 * Sentiment analysis results for a review
 */
export interface LabelResult {
  reviewId: string;
  theme: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  severity: number; // 1-5 scale
  featureRequest: boolean;
  directQuote: string;
  confidence: number;
  modelVersion: string;
}

/**
 * Configuration for the labeling process
 */
export interface LabelingConfig {
  model: string;
  batchSize: number;
  maxRetries: number;
  timeoutMs: number;
}

/**
 * Node.js implementation of review sentiment analysis
 * Replaces the Python batch_label_reviews.py with better integration
 */
export class ReviewLabeler {
  private openai: OpenAI;
  private logger: Logger;
  private db: DatabasePool;
  private taxonomy: any;

  constructor(config: {
    apiKey: string;
    taxonomyPath?: string;
  }) {
    this.logger = new Logger('ReviewLabeler');
    this.db = getDatabasePool();
    
    this.openai = new OpenAI({
      apiKey: config.apiKey,
    });

    // Load taxonomy (simplified version for now)
    this.taxonomy = this.getDefaultTaxonomy();
  }

  /**
   * Label a batch of reviews with sentiment analysis
   */
  async labelReviews(
    reviews: Review[], 
    config: Partial<LabelingConfig> = {}
  ): Promise<LabelResult[]> {
    const finalConfig: LabelingConfig = {
      model: 'gpt-4o-mini',
      batchSize: 20,
      maxRetries: 3,
      timeoutMs: 120000,
      ...config,
    };

    this.logger.info(`Starting to label ${reviews.length} reviews`, {
      model: finalConfig.model,
      batchSize: finalConfig.batchSize,
    });

    const results: LabelResult[] = [];
    
    // Process reviews in batches
    for (let i = 0; i < reviews.length; i += finalConfig.batchSize) {
      const batch = reviews.slice(i, i + finalConfig.batchSize);
      
      try {
        this.logger.debug(`Processing batch ${Math.floor(i / finalConfig.batchSize) + 1}/${Math.ceil(reviews.length / finalConfig.batchSize)}`);
        
        const batchResults = await this.labelBatch(batch, finalConfig);
        results.push(...batchResults);
        
        // Small delay between batches to be respectful to API
        if (i + finalConfig.batchSize < reviews.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
      } catch (error) {
        this.logger.error(`Failed to process batch starting at index ${i}:`, error);
        
        // Add failed results for this batch
        batch.forEach(review => {
          results.push({
            reviewId: review.id,
            theme: 'General Feedback',
            sentiment: 'neutral',
            severity: 1,
            featureRequest: false,
            directQuote: '',
            confidence: 0,
            modelVersion: finalConfig.model,
          });
        });
      }
    }

    this.logger.info(`Completed labeling ${results.length} reviews`);
    return results;
  }

  /**
   * Process a single batch of reviews
   */
  private async labelBatch(
    reviews: Review[], 
    config: LabelingConfig
  ): Promise<LabelResult[]> {
    // Prepare the prompt with taxonomy and review data
    const reviewsText = reviews.map((review, index) => 
      `${index + 1}. ID: ${review.id}\nText: "${review.text}"\n---`
    ).join('\n');

    const systemPrompt = `You are a meticulous analyst focused on extracting structured data from app reviews. 

Analyze each review based on this taxonomy:
${JSON.stringify(this.taxonomy, null, 2)}

For EACH review, identify:
1. ONE primary theme from the taxonomy (use "General Feedback" if none fit)
2. Sentiment: positive | neutral | negative  
3. Severity: 1-5 scale (1=minor, 5=critical, use 1 for positive/neutral)
4. Feature request: true/false (user explicitly suggests adding/improving a feature)
5. Direct quote: extract 1-20 words that best represent the sentiment

Return ONLY a JSON array with this exact structure:
[
  {
    "reviewId": "review_id_here",
    "theme": "theme_name",
    "sentiment": "positive|neutral|negative", 
    "severity": 1-5,
    "featureRequest": true/false,
    "directQuote": "exact quote from review",
    "confidence": 0.0-1.0
  }
]`;

    const userPrompt = `Analyze these app reviews:\n\n${reviewsText}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      // Parse the JSON response
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(content);
      } catch (parseError) {
        this.logger.error('Failed to parse OpenAI response as JSON:', content);
        throw new Error('Invalid JSON response from OpenAI');
      }

      // Extract results array (handle both direct array and object with results key)
      const resultsArray = Array.isArray(parsedResponse) ? parsedResponse : parsedResponse.results;
      
      if (!Array.isArray(resultsArray)) {
        throw new Error('OpenAI response does not contain a results array');
      }

      // Validate and clean up results
      const results: LabelResult[] = resultsArray.map((result: any) => ({
        reviewId: result.reviewId || '',
        theme: result.theme || 'General Feedback',
        sentiment: ['positive', 'neutral', 'negative'].includes(result.sentiment) 
          ? result.sentiment : 'neutral',
        severity: Math.max(1, Math.min(5, parseInt(result.severity) || 1)),
        featureRequest: Boolean(result.featureRequest),
        directQuote: (result.directQuote || '').slice(0, 100), // Limit quote length
        confidence: Math.max(0, Math.min(1, parseFloat(result.confidence) || 0.5)),
        modelVersion: config.model,
      }));

      this.logger.debug(`Successfully processed batch of ${results.length} reviews`);
      return results;

    } catch (error) {
      this.logger.error('OpenAI API call failed:', error);
      throw error;
    }
  }

  /**
   * Save labeling results to database
   */
  async saveLabelResults(results: LabelResult[]): Promise<void> {
    if (results.length === 0) {
      return;
    }

    this.logger.info(`Saving ${results.length} label results to database`);

    try {
      const batchSize = 50;
      let savedCount = 0;

      for (let i = 0; i < results.length; i += batchSize) {
        const batch = results.slice(i, i + batchSize);
        
        for (const result of batch) {
          try {
            await this.db.query(`
              INSERT INTO labels (
                id, review_id, sentiment, confidence, theme, severity, 
                feature_request, direct_quote, model_version, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
              ON CONFLICT (review_id) DO UPDATE SET
                sentiment = EXCLUDED.sentiment,
                confidence = EXCLUDED.confidence,
                theme = EXCLUDED.theme,
                severity = EXCLUDED.severity,
                feature_request = EXCLUDED.feature_request,
                direct_quote = EXCLUDED.direct_quote,
                model_version = EXCLUDED.model_version,
                updated_at = NOW()
            `, [
              `label_${Date.now()}_${Math.random().toString(36).slice(2)}`,
              result.reviewId,
              result.sentiment,
              result.confidence,
              result.theme,
              result.severity,
              result.featureRequest,
              result.directQuote,
              result.modelVersion
            ]);
            savedCount++;
          } catch (error) {
            this.logger.error(`Failed to save label for review ${result.reviewId}:`, error);
          }
        }
      }

      this.logger.info(`Successfully saved ${savedCount}/${results.length} label results`);
    } catch (error) {
      this.logger.error('Failed to save label results:', error);
      throw error;
    }
  }

  /**
   * Get reviews that need labeling
   */
  async getUnlabeledReviews(limit: number = 100): Promise<Review[]> {
    try {
      const result = await this.db.query(`
        SELECT r.* FROM reviews r
        LEFT JOIN labels l ON r.id = l.review_id
        WHERE l.review_id IS NULL
        ORDER BY r.created_at DESC
        LIMIT $1
      `, [limit]);

      return result.rows.map(row => ({
        id: row.id,
        userName: row.user_name,
        userUrl: row.user_url,
        version: row.version,
        score: row.score,
        title: row.title,
        text: row.text,
        url: row.url,
        date: row.date,
        replyDate: row.reply_date,
        replyText: row.reply_text,
        helpfulVotes: row.helpful_votes,
        country: row.country,
      }));
    } catch (error) {
      this.logger.error('Failed to get unlabeled reviews:', error);
      throw error;
    }
  }

  /**
   * Default taxonomy (simplified version)
   */
  private getDefaultTaxonomy() {
    return {
      themes: [
        { name: 'UI/UX Design', description: 'User interface and experience issues' },
        { name: 'Performance', description: 'App speed, crashes, loading issues' },
        { name: 'Features', description: 'App functionality and capabilities' },
        { name: 'Bugs/Errors', description: 'Technical issues and bugs' },
        { name: 'Authentication', description: 'Login, signup, account issues' },
        { name: 'Data/Sync', description: 'Data synchronization and storage' },
        { name: 'Pricing', description: 'Cost, billing, subscription issues' },
        { name: 'Customer Support', description: 'Help, support, documentation' },
        { name: 'General Feedback', description: 'General comments and feedback' }
      ]
    };
  }
}