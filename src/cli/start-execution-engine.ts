import { startExecutionEngine } from 'scripts/start-execution-engine';

async function main() {
  const args = process.argv.slice(2);
  const version = args.find((item) => item.toLowerCase().startsWith('version='))?.split?.('=')?.[1] ?? null;

  await startExecutionEngine(version);
  process.exit(1);
}

void main();
