import { ValueTransformer } from 'typeorm';

/**
 * Postgres BIGINT is returned by the `pg` driver as a string. Use this on every
 * *_paise column so amounts are always JS integers (never strings, never floats):
 *
 *   @Column({ type: 'bigint', transformer: paiseTransformer })
 *   amountPaise: number;
 *
 * Amounts here are far below Number.MAX_SAFE_INTEGER (about 9 quadrillion paise),
 * and anything that isn't a safe integer is rejected loudly instead of being
 * silently rounded.
 */
export const paiseTransformer: ValueTransformer = {
  to(value?: number | null): number | null | undefined {
    if (value === null || value === undefined) return value;
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Invalid paise amount (must be a safe integer): ${String(value)}`,
      );
    }
    return value;
  },
  from(value?: string | null): number | null | undefined {
    if (value === null || value === undefined) return value;
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(
        `Paise value from database is not a safe integer: ${value}`,
      );
    }
    return n;
  },
};
