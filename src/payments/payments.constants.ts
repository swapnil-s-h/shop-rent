/** Injection token for the Razorpay environment this deployment talks to ('test' | 'live'). */
export const PAYMENT_ENV = Symbol('PAYMENT_ENV');

/**
 * Hours to wait after a bank-side failure before initiating the next debit attempt.
 * Each attempt triggers a new pre-debit notification and the debit follows ~25 hours
 * later, so retrying more often than daily makes no sense.
 */
export const RETRY_DELAY_HOURS = 24;

/**
 * failure_code for an attempt the provider definitively rejected before accepting it
 * (nothing was created at the provider). Such attempts do not use up a retry.
 */
export const PROVIDER_REJECTED = 'provider_rejected';

/** Discrepancy kinds raised by PaymentService for a human to resolve. */
export const DISCREPANCY = {
  OVERPAYMENT: 'overpayment',
  PAYMENT_ON_CLOSED_CYCLE: 'payment_on_closed_cycle',
  SUCCESS_AFTER_FAILURE: 'success_after_failure',
  FAILURE_AFTER_SUCCESS: 'failure_after_success',
} as const;
