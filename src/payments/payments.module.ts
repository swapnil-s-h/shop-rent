import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Env } from '../config/env.validation';
import type { PaymentEnvironment } from '../mandates/mandate.entity';
import { LedgerEntry } from './ledger-entry.entity';
import { Payment } from './payment.entity';
import { PAYMENT_ENV } from './payments.constants';
import { PaymentService } from './payments.service';

/** Only this module registers the payment and ledger entities (see PaymentService). */
@Module({
  imports: [TypeOrmModule.forFeature([Payment, LedgerEntry])],
  providers: [
    PaymentService,
    {
      provide: PAYMENT_ENV,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.getOrThrow<PaymentEnvironment>('PAYMENT_ENV'),
    },
  ],
  exports: [PaymentService],
})
export class PaymentsModule {}
