import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { paiseTransformer } from '../payments/paise.transformer';

/** Rent history for a lease: the term with the latest effective_from <= a date applies. */
@Entity({ name: 'lease_rent_terms' })
export class LeaseRentTerm {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'lease_id', type: 'uuid' })
  leaseId!: string;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom!: string;

  @Column({
    name: 'amount_paise',
    type: 'bigint',
    transformer: paiseTransformer,
  })
  amountPaise!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
