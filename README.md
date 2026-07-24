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

1. Activate Stripe Managed Payments and create eligible Starter/Freelancer monthly and annual prices.
2. Create the refundable $5 Founding Reservation product and set its price ID.
3. Configure the support email, verified sender, and Stripe price IDs. Add a production D1 ID only when using a manually created database instead of Wrangler provisioning.
4. Create the production D1, R2 buckets, queues, and dead-letter queue.
5. Onboard the sending domain to Cloudflare Email Sending and configure SPF, DKIM, and DMARC.
6. Store `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` with `wrangler secret put --env production`.
7. Apply D1 migrations and deploy only after final trademark clearance and the launch gate.

See:

- `docs/validation-playbook.md`
- `docs/demo-script.md`
- `docs/production-runbook.md`
