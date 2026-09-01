/**
 * Provider gateway: rate limiting, circuit breaking, caching, and User-Agent enforcement.
 * Implements spec §10.2, §12.4.
 */
import type {
  CallContext,
  MetadataProvider,
  RateLimitConfig,
  ProviderRateLimitState,
} from './types.js';

/**
 * Default rate limit configurations per provider.
 * From spec Appendix C and §10.2.1.
 */
const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  musicbrainz: {
    requestsPerSecond: 1,
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000, // 10 minutes
  },
  discogs: {
    requestsPerMinute: 55, // authenticated
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000,
  },
  acoustid: {
    requestsPerSecond: 3,
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000,
  },
  critiquebrainz: {
    requestsPerSecond: 1,
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000,
  },
  wikipedia: {
    concurrency: 1,
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000,
  },
  wikidata: {
    concurrency: 1,
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000,
  },
  caa: {
    concurrency: 4,
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000,
  },
  lastfm: {
    requestsPerSecond: 1,
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000,
  },
  theaudiodb: {
    requestsPerSecond: 2,
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000,
  },
  fanart: {
    concurrency: 2,
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000,
  },
  lidarr: {
    concurrency: 2,
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000,
  },
  itunes: {
    requestsPerMinute: 20,
    failureThreshold: 5,
    openDurationMs: 10 * 60 * 1000,
  },
};

/**
 * Token bucket for rate limiting.
 */
class TokenBucket {
  private tokens: number;
  private lastRefillAt: number = Date.now();

  constructor(
    private capacity: number,
    private refillPerSecond: number
  ) {
    this.tokens = capacity;
  }

  /**
   * Try to consume tokens. Returns true if successful, false if rate limited.
   */
  tryConsume(count: number = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /**
   * Refill the bucket based on elapsed time.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillAt) / 1000;
    const tokensToAdd = elapsed * this.refillPerSecond;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillAt = now;
  }

  /**
   * Get current fill ratio (0-1).
   */
  getFillRatio(): number {
    this.refill();
    return this.tokens / this.capacity;
  }
}

/**
 * Circuit breaker state.
 */
enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

/**
 * Provider gateway with rate limiting, circuit breaking, and caching.
 */
export class ProviderGateway {
  private contactUrl: string = '';
  private providers: Map<string, MetadataProvider> = new Map();
  private buckets: Map<string, TokenBucket> = new Map();
  private circuitBreakers: Map<string, { state: CircuitState; openUntil?: number; failures: number }> = new Map();
  private cache: Map<string, { value: unknown; expiresAt: number }> = new Map();
  private limiterConfig: Map<string, RateLimitConfig> = new Map();

  constructor() {
    // Initialize default limits
    for (const [provider, config] of Object.entries(DEFAULT_LIMITS)) {
      this.limiterConfig.set(provider, config);
    }
  }

  /**
   * Set the contact string (required for User-Agent).
   */
  setContactUrl(url: string): void {
    if (!url || url.trim() === '') {
      throw new Error('Contact URL is required and cannot be empty');
    }
    this.contactUrl = url;
  }

  /**
   * Get the User-Agent string.
   */
  getUserAgent(version: string = '0.1.0'): string {
    if (!this.contactUrl) {
      throw new Error('User-Agent contact string not set');
    }
    return `Liner/${version} (+${this.contactUrl})`;
  }

  /**
   * Register a metadata provider.
   */
  registerProvider(provider: MetadataProvider): void {
    this.providers.set(provider.id, provider);
    this.initializeCircuitBreaker(provider.id);
  }

  /**
   * Initialize circuit breaker for a provider.
   */
  private initializeCircuitBreaker(providerId: string): void {
    this.circuitBreakers.set(providerId, {
      state: CircuitState.CLOSED,
      failures: 0,
    });
  }

  /**
   * Wrap a provider call with rate limiting, circuit breaking, and caching.
   */
  async call<T>(
    providerId: string,
    cacheKey: string,
    fn: () => Promise<T>,
    ctx: CallContext,
    cacheTtlSeconds: number = 3600
  ): Promise<T> {
    if (!this.contactUrl) {
      throw new Error('Gateway: User-Agent contact string not set (call setContactUrl first)');
    }

    // Check circuit breaker
    const breaker = this.circuitBreakers.get(providerId);
    if (breaker?.state === CircuitState.OPEN) {
      if (breaker.openUntil && Date.now() < breaker.openUntil) {
        throw new Error(
          `Provider ${providerId} circuit open: too many failures (retry in ${Math.ceil((breaker.openUntil - Date.now()) / 1000)}s)`
        );
      } else {
        // Try to recover: move to half-open
        breaker.state = CircuitState.HALF_OPEN;
        breaker.failures = 0;
      }
    }

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as T;
    }

    // Rate limit based on priority
    const config = this.limiterConfig.get(providerId);
    if (config?.requestsPerSecond) {
      const bucket = this.getOrCreateBucket(providerId, config);
      if (!bucket.tryConsume(1)) {
        throw new Error(
          `Provider ${providerId} rate limited (try again in ~${Math.ceil(1 / (config.requestsPerSecond * 0.5))}s)`
        );
      }
    }

    // Execute call
    try {
      const result = await fn();
      // Reset circuit breaker on success
      if (breaker) {
        breaker.state = CircuitState.CLOSED;
        breaker.failures = 0;
      }
      // Cache result
      this.cache.set(cacheKey, {
        value: result,
        expiresAt: Date.now() + cacheTtlSeconds * 1000,
      });
      return result;
    } catch (error) {
      // Track failure for circuit breaker
      if (breaker) {
        breaker.failures++;
        if (breaker.failures >= (config?.failureThreshold || 5)) {
          breaker.state = CircuitState.OPEN;
          breaker.openUntil = Date.now() + (config?.openDurationMs || 10 * 60 * 1000);
        }
      }
      throw error;
    }
  }

  /**
   * Get or create a token bucket for a provider.
   */
  private getOrCreateBucket(providerId: string, config: RateLimitConfig): TokenBucket {
    if (this.buckets.has(providerId)) {
      return this.buckets.get(providerId)!;
    }

    let bucket: TokenBucket;
    if (config.requestsPerSecond) {
      bucket = new TokenBucket(config.requestsPerSecond, config.requestsPerSecond);
    } else if (config.requestsPerMinute) {
      const perSec = config.requestsPerMinute / 60;
      bucket = new TokenBucket(config.requestsPerMinute, perSec);
    } else {
      // Default: 1 request per second
      bucket = new TokenBucket(1, 1);
    }

    this.buckets.set(providerId, bucket);
    return bucket;
  }

  /**
   * Clear all caches.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get provider state for persistence (for the database).
   */
  getProviderState(providerId: string): Partial<ProviderRateLimitState> {
    const breaker = this.circuitBreakers.get(providerId);
    const bucket = this.buckets.get(providerId);

    return {
      provider: providerId,
      windowStartedAt: new Date(),
      requestsUsed: bucket ? Math.round((1 - bucket.getFillRatio()) * 100) : 0,
      circuitOpenUntil: breaker?.openUntil ? new Date(breaker.openUntil) : undefined,
    };
  }

  /**
   * Check if a provider is available (not circuit-broken).
   */
  isProviderAvailable(providerId: string): boolean {
    const breaker = this.circuitBreakers.get(providerId);
    if (!breaker || breaker.state === CircuitState.CLOSED) {
      return true;
    }
    if (breaker.state === CircuitState.OPEN && breaker.openUntil && Date.now() >= breaker.openUntil) {
      return true; // Can retry
    }
    return false;
  }
}
