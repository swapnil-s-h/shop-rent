import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Env } from '../config/env.validation';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres' as const,
        url: config.get('DATABASE_URL', { infer: true }),
        autoLoadEntities: true,
        synchronize: false, // never: schema changes only through migrations
        migrationsRun: false, // run migrations explicitly (npm run migration:run)
        extra: { options: '-c timezone=UTC' },
      }),
    }),
  ],
})
export class DatabaseModule {}
