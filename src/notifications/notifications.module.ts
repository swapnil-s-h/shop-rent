import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Device } from './device.entity';
import { NotificationOutbox } from './notification-outbox.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Device, NotificationOutbox])],
  exports: [TypeOrmModule],
})
export class NotificationsModule {}
