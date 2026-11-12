import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export const WEBHOOK_EVENT_STATUSES = [
  'received',
  'processing',
  'processed',
  'failed',
  'ignored',
] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

@Entity({ name: 'webhook_events' })
export class WebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  provider: string;

  @Column({ name: 'provider_event_id', type: 'text' })
  providerEventId: string;

  @Column({ name: 'event_type', type: 'text', nullable: true })
  eventType: string | null;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'signature_valid', type: 'boolean' })
  signatureValid: boolean;

  @Column({ type: 'text' })
  status: WebhookEventStatus;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
