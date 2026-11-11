import 'dotenv/config';
import { join } from 'path';
import { DataSource } from 'typeorm';

/**
 * Used by the TypeORM CLI (migrations) and shared with the Nest DatabaseModule.
 * synchronize is permanently OFF: the schema changes only through migrations.
 */
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  synchronize: false,
  migrationsRun: false,
  // Keep timestamptz handling in UTC; business dates (IST) are handled in app code.
  extra: { options: '-c timezone=UTC' },
});
