# Production runbook

## Required decisions

- Confirm the product name with trademark and domain searches.
- Replace the placeholder support and sender domains.
- Have the Terms, Privacy Policy, and Refund Policy reviewed for the operating entity and launch markets.
- Confirm that Stripe Managed Payments is enabled for the account and target buyer countries.

## Cloudflare resources

The Git-connected Worker must be named `retainerproof-production` because the production deploy uses the `production` Wrangler environment.

Use these Workers Builds settings:

- Production branch: `main`
- Root directory: `/`
- Build command: `npm run build:production`
- Deploy command: `npx wrangler deploy`

Wrangler can provision the named D1, R2, and Queue resources on the first deploy. Confirm that it created:

- D1: `retainerproof-production`
- R2: `retainerproof-reports-production`
- Queue: `retainerproof-monitor-production`
- Dead-letter queue: `retainerproof-monitor-production-dlq`

If the resources are created manually instead, add the real D1 `database_id` to the production binding in `wrangler.jsonc`. In either case, apply migrations before enabling sign-in.

Set secrets without putting them in files or logs:

```sh
npx wrangler secret put BETTER_AUTH_SECRET --env production
npx wrangler secret put STRIPE_SECRET_KEY --env production
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env production
```

Configure SPF, DKIM, and DMARC for the sending domain, then update `EMAIL_FROM`. Add the Stripe price IDs for Starter monthly/yearly and Freelancer monthly/yearly.

## Stripe Managed Payments

- Create four recurring prices: $5 monthly, $50 yearly, $12 monthly, $120 yearly.
- Enable Managed Payments on every Checkout Session.
- Register `/api/billing/webhook`.
- Subscribe to Checkout completion and subscription update/deletion events.
- Test duplicate delivery, out-of-order delivery, failed payment, cancellation, and refund.
- State on the purchase page and terms that Link is the seller and that a custom checkout domain is not used.
- Route Stripe product-support messages to a monitored inbox with a 48-hour response target.

## Release sequence

1. Connect `wayhiroshi/RetainerProof` to the `retainerproof-production` Worker.
2. Deploy to the Workers preview URL and confirm all four named resources exist.
3. Apply the D1 migrations with `npx wrangler d1 migrations apply retainerproof-production --remote --env production`.
4. Run registration → Magic Link → client → activity → monitoring → AI rewrite → report → PDF → delivery → checkout → cancellation.
5. Test a second workspace against every first-workspace identifier.
6. Verify desktop, 390px mobile, and print output.
7. Onboard the three founding customers manually.
8. Do not announce general availability until the beta thresholds are met.

## Operations

Alert on authentication, queue, monitoring, AI, PDF, email, and webhook failures. Logs must contain IDs and error codes, never secrets, AI input, report copy, or email bodies. Export D1 regularly and test restore. Schedule customer-content deletion within 30 days after closure, excluding legally required billing records.
