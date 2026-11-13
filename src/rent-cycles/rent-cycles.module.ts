import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RentCycle } from './rent-cycle.entity';

/** Read side only. Status and money fields are written by PaymentService. */
@Module({
  imports: [TypeOrmModule.forFeature([RentCycle])],
  exports: [TypeOrmModule],
})
export class RentCyclesModule {}
