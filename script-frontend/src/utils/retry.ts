/**
 * Retry a function with exponential backoff
 * @param fn - The async function to retry
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param initialDelayMs - Initial delay in milliseconds before first retry (default: 1000)
 * @param backoffMultiplier - Multiplier for exponential backoff (default: 2)
 * @param maxDelayMs - Maximum delay between retries in milliseconds (optional)
 * @param logError - Optional function to log retry attempts (can be async for cleanup operations)
 */
export async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  initialDelayMs = 1000,
  backoffMultiplier = 2,
  maxDelayMs?: number,
  logError?: (attempt: number, error: unknown, delayMs: number) => void | Promise<void>,
): Promise<T> {
  let lastError: unknown;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      
      if (attempt < maxRetries) {
        // Calculate delay with exponential backoff
        // For attempt 1: wait initialDelayMs (e.g., 1000ms)
        // For attempt 2: wait initialDelayMs * backoffMultiplier (e.g., 2000ms)
        // For attempt 3: wait initialDelayMs * backoffMultiplier^2 (e.g., 4000ms)
        const delayMs = Math.min(
          initialDelayMs * Math.pow(backoffMultiplier, attempt - 1),
          maxDelayMs || Infinity
        );
        
        if (logError) {
          await logError(attempt, e, delayMs);
        }
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  // If we get here, all retries failed
  throw lastError;
}

