import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookEvent } from './webhook-event.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WebhookEvent])],
  exports: [TypeOrmModule],
})
export class WebhooksModule {}
