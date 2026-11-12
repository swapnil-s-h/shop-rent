import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const USER_ROLES = ['tenant', 'owner', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Entities map columns only (no @ManyToOne/@OneToMany). Foreign keys are enforced
 * by the database, and queries join explicitly. This keeps module boundaries clean
 * and avoids circular imports between entity files.
 */
@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  role: UserRole;

  /** E.164 Indian number, e.g. +919876543210 */
  @Column({ type: 'text' })
  phone: string;

  @Column({ name: 'firebase_uid', type: 'text', nullable: true })
  firebaseUid: string | null;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  status: UserStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
