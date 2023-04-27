import 'module-alias/register';

import { startMatchingEngine } from '@/scripts/start-matching-engine';

async function main() {
  const args = process.argv.slice(2);
  const version = args.find((item) => item.toLowerCase().startsWith('version='))?.split?.('=')?.[1] ?? null;

  await startMatchingEngine(version);
  process.exit(1);
}

void main();
