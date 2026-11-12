import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Discrepancy } from './discrepancy.entity';
import { ReconciliationRun } from './reconciliation-run.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ReconciliationRun, Discrepancy])],
  exports: [TypeOrmModule],
})
export class ReconciliationModule {}
