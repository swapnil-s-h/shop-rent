import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { CommonModule } from './common/common.module';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { LeasesModule } from './leases/leases.module';
import { MandatesModule } from './mandates/mandates.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PaymentsModule } from './payments/payments.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { RentCyclesModule } from './rent-cycles/rent-cycles.module';
import { ShopsModule } from './shops/shops.module';
import { UsersModule } from './users/users.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DatabaseModule,
    CommonModule,
    UsersModule,
    ShopsModule,
    LeasesModule,
    MandatesModule,
    RentCyclesModule,
    PaymentsModule,
    WebhooksModule,
    AuditModule,
    NotificationsModule,
    ReconciliationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
