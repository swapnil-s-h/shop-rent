import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().min(1),

    JWT_ACCESS_SECRET: z.string().min(32, 'use at least 32 random characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'use at least 32 random characters'),

    // Which Razorpay environment this deployment talks to. Stored on every mandate (env column).
    PAYMENT_ENV: z.enum(['test', 'live']).default('test'),
    RAZORPAY_KEY_ID: z.string().min(1),
    RAZORPAY_KEY_SECRET: z.string().min(1),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1),

    FIREBASE_PROJECT_ID: z.string().min(1),
    FIREBASE_CLIENT_EMAIL: z.string().min(1),
    // Paste the key with literal \n sequences in .env; they are converted below.
    FIREBASE_PRIVATE_KEY: z.string().min(1),
  })
  .superRefine((env, ctx) => {
    // Safety net: test keys can never run in a "live" deployment, or the reverse.
    const expectedPrefix =
      env.PAYMENT_ENV === 'live' ? 'rzp_live_' : 'rzp_test_';
    if (!env.RAZORPAY_KEY_ID.startsWith(expectedPrefix)) {
      ctx.addIssue({
        code: 'custom',
        path: ['RAZORPAY_KEY_ID'],
        message: `PAYMENT_ENV=${env.PAYMENT_ENV} requires a key starting with ${expectedPrefix}`,
      });
    }
    if (env.NODE_ENV !== 'production' && env.PAYMENT_ENV === 'live') {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENT_ENV'],
        message: 'PAYMENT_ENV=live is only allowed when NODE_ENV=production',
      });
    }
  })
  .transform((env) => ({
    ...env,
    FIREBASE_PRIVATE_KEY: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }));

export type Env = z.infer<typeof envSchema>;

/** Used by ConfigModule.forRoot({ validate }). Fails fast at startup with a readable message. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
