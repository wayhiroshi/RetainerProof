# RetainerProof

RetainerProof turns website maintenance activity and public health checks into client-ready monthly reports.

The product name remains configurable. A July 2026 preliminary screening found no obvious exact-match conflict for RetainerProof in general web results or the USPTO database. Complete international and professional trademark clearance before a full public launch.

## Local setup

```bash
npm install
cp .env.example .dev.vars
npm run types:bindings
npm run db:local
npm run dev
```

In development, magic-link requests are accepted by the local email preview path without transmitting email. Use a test mailbox and a configured delivery provider for full link-consumption testing.

## Verification

```bash
npm run verify
```

Production builds use `CLOUDFLARE_ENV=production` through `npm run build:production`. With the Cloudflare Vite plugin, selecting the environment only at `wrangler deploy` time is too late because the deploy configuration is flattened during the Vite build.

## Production dependencies

Before production deployment:

1. Activate Stripe Managed Payments and classify the RetainerProof products as `Software as a service (SaaS) - business use` (`txcd_10103001`).
2. Create USD prices for the refundable $5 Founding Reservation, Starter ($5 monthly / $50 yearly), and Freelancer ($12 monthly / $120 yearly).
3. Create a USD $5 `once` coupon for the Founding Reservation credit and configure all five Price IDs plus the Coupon ID in `wrangler.jsonc`.
4. Register `https://retainerproof.aether42.com/api/billing/webhook` and subscribe it to:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.subscription.paused`
   - `customer.subscription.resumed`
   - `charge.refunded`
5. Configure a monitored Stripe support email. Add a production D1 ID only when using a manually created database instead of Wrangler provisioning.
6. Create the production D1, R2 buckets, queues, and dead-letter queue.
7. Use the existing Resend-verified `notify.aether42.com` sending domain and keep its SPF, DKIM, and return-path DNS records intact.
8. Create a RetainerProof-only Resend key with sending access restricted to `notify.aether42.com`, then store `RESEND_API_KEY`, `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` with `wrangler secret put --env production`.
9. Apply D1 migrations and deploy only after final trademark clearance and the launch gate.

See:

- `docs/validation-playbook.md`
- `docs/demo-script.md`
- `docs/production-runbook.md`
