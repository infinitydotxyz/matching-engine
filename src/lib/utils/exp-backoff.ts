export function* expBackoff(maxAttempts: number, initialDelay: number) {
  for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
    yield { attempts, delay: initialDelay ** attempts, maxAttempts };
  }
}
