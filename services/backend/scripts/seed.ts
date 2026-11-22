import { env } from '../src/config/env';
import { MysqlRepository } from '../src/db/mysqlRepository';
import { seedInitialData } from '../src/db/seedData';

async function runSeed(): Promise<void> {
  const repo = new MysqlRepository(env);
  try {
    await seedInitialData(repo, env);
    console.log('Seeded FlowMind AI demo tenants, users, and sample orders into MySQL.');
  } finally {
    await repo.close();
  }
}

runSeed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
