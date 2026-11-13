import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { paiseTransformer } from '../payments/paise.transformer';

export const MANDATE_STATUSES = [
  'pending_auth',
  'active',
  'paused',
  'cancelled',
  'failed',
  'expired',
] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

export type PaymentEnvironment = 'test' | 'live';

@Entity({ name: 'mandates' })
export class Mandate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'lease_id', type: 'uuid' })
  leaseId!: string;

  @Column({ type: 'text' })
  provider!: string;

  /** Which provider environment created this mandate. Test and live never mix. */
  @Column({ type: 'text' })
  env!: PaymentEnvironment;

  @Column({ name: 'provider_customer_id', type: 'text', nullable: true })
  providerCustomerId!: string | null;

  @Column({ name: 'provider_token_id', type: 'text', nullable: true })
  providerTokenId!: string | null;

  @Column({
    name: 'max_amount_paise',
    type: 'bigint',
    transformer: paiseTransformer,
  })
  maxAmountPaise!: number;

  @Column({ name: 'valid_from', type: 'date', nullable: true })
  validFrom!: string | null;

  @Column({ name: 'valid_to', type: 'date', nullable: true })
  validTo!: string | null;

  @Column({ type: 'text' })
  status!: MandateStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
