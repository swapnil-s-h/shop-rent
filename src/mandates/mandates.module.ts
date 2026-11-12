import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Mandate } from './mandate.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Mandate])],
  exports: [TypeOrmModule],
})
export class MandatesModule {}
