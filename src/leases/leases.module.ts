import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeaseRentTerm } from './lease-rent-term.entity';
import { Lease } from './lease.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Lease, LeaseRentTerm])],
  exports: [TypeOrmModule],
})
export class LeasesModule {}
