declare global {
  interface Env {
    BETTER_AUTH_SECRET: string;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SECRET: string;
  }
}

export {};
