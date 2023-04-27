export function* expBackoff(maxAttempts: number, initialDelaySeconds: number) {
  for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
    const delay = initialDelaySeconds ** attempts * 1000;
    yield { attempts, delay: delay, maxAttempts };
  }
}
