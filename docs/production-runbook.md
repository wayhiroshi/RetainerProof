# Production runbook

## Required decisions

- Confirm the product name with trademark and domain searches.
- Replace the placeholder support and sender domains.
- Have the Terms, Privacy Policy, and Refund Policy reviewed for the operating entity and launch markets.
- Confirm that Stripe Managed Payments is enabled for the account and target buyer countries.

## Cloudflare resources

The Git-connected Worker is named `retainerproof`. Its production build selects the `production` Wrangler environment while retaining the connected Worker name.

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
npx wrangler secret put RESEND_API_KEY --env production
npx wrangler secret put STRIPE_SECRET_KEY --env production
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env production
```

## Transactional email without Workers Paid

RetainerProof sends transactional mail by calling the Resend REST API from the Worker. It does not use Cloudflare Email Sending or its paid-plan binding.

- Reuse the existing Resend-verified `notify.aether42.com` domain.
- Send from `RetainerProof <retainerproof@notify.aether42.com>`.
- Create a dedicated API key with sending-only permission restricted to `notify.aether42.com`; do not reuse another product's key.
- Store the key only as the production Worker secret `RESEND_API_KEY`.
- Use the monitored `retainerproof@aether42.com` mailbox for the public support address and `EMAIL_REPLY_TO`. It forwards to the operator's monitored inbox.
- Preserve the domain's Resend SPF, DKIM, and return-path records.
- Confirm the current Resend plan limits before launch.

The Worker submits both HTML and plain-text bodies, uses a hashed idempotency key, requires a provider message ID, and records only the existing delivery status/message ID. It does not log the API key or message body.

Add the Stripe price IDs for Starter monthly/yearly and Freelancer monthly/yearly.

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
