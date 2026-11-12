import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { paiseTransformer } from './paise.transformer';

export const PAYMENT_METHODS = ['mandate', 'pay_link', 'cash'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = [
  'created',
  'submitted',
  'succeeded',
  'failed',
  'reversed',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

@Entity({ name: 'payments' })
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'rent_cycle_id', type: 'uuid' })
  rentCycleId!: string;

  @Column({ type: 'text' })
  method!: PaymentMethod;

  /** Per cycle and method, starting at 1. */
  @Column({ name: 'attempt_no', type: 'int' })
  attemptNo!: number;

  @Column({
    name: 'amount_paise',
    type: 'bigint',
    transformer: paiseTransformer,
  })
  amountPaise!: number;

  @Column({ type: 'text' })
  status!: PaymentStatus;

  /** Globally unique. Also sent to the provider so events can be mapped back to us. */
  @Column({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string;

  @Column({ name: 'provider_ref', type: 'text', nullable: true })
  providerRef!: string | null;

  @Column({ name: 'failure_code', type: 'text', nullable: true })
  failureCode!: string | null;

  /** Cash only: the owner who recorded it. */
  @Column({ name: 'recorded_by', type: 'uuid', nullable: true })
  recordedBy!: string | null;

  /** Cash only: the tenant who confirmed it. */
  @Column({ name: 'confirmed_by', type: 'uuid', nullable: true })
  confirmedBy!: string | null;

  /** Cash only: set when the tenant disputes the recorded payment. */
  @Column({ name: 'disputed_at', type: 'timestamptz', nullable: true })
  disputedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
