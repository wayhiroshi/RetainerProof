# Post-MVP backlog

## Japanese localization

Add Japanese as an optional locale while keeping English as the default for the global market.

- Provide an `English / 日本語` UI switch.
- Publish the English landing page at `/` and the Japanese version at `/ja`.
- Store a default UI locale for each workspace.
- Store the report language separately for each client.
- Generate AI rewrites, report emails, shared reports, and PDFs in the selected client language.
- Save the report locale in each finalized revision so existing snapshots never change language.
- Allow a Japanese-speaking maintainer to use the Japanese UI while sending English reports to international clients.

This is intentionally deferred until the English MVP flow and initial paid-customer validation are complete.

## Shared form health checks

Status: first shared phase implemented. Production monitoring is enabled only for forms deliberately registered by a signed-in workspace owner. H-KKS registration and every real submission remain separate rollout gates.

Add one reusable RetainerProof capability for checking customer forms across projects. Do not create an H-KKS-specific monitor or copy monitoring logic into each website. RetainerProof should continue to use the existing Aether42 shared security monitor only for RetainerProof's own `/api/health`; customer form checks belong to RetainerProof's generic asset/check pipeline.

### Three check layers

1. Run a bounded, non-submitting page check daily or at a configured interval. Confirm that the page is reachable and that the expected form, required controls, submit control, Turnstile script, and named widget marker are present. Retry once after five minutes and notify only after two consecutive failures.
2. Create a monthly supervised real-submission task. Use a dedicated test identity and unique test ID, require a human to complete Turnstile when requested, then record whether the website accepted the submission, WordPress recorded it, the administrator notification arrived, and the auto-reply arrived. Never bypass or automate a human challenge.
3. Create the same supervised real-submission task immediately after a recorded WordPress core/theme/plugin update, restore or migration, Cloudflare/Turnstile change, form or recipient change, or mail/DNS change.

### Data boundary

Reuse the existing client, managed asset, Queue, five-minute retry, owner notification, and check-run concepts. Add only the minimum generic form-monitor metadata and checkpoint results needed across projects:

- workspace/client and managed asset references;
- form URL and form type;
- non-secret Turnstile widget name;
- check mode and trigger (`scheduled_presence`, `scheduled_submission`, or `post_change`);
- opaque test ID;
- last successful display check and real-submission check;
- page/form/Turnstile/control presence results;
- WordPress receipt, administrator notification, and auto-reply states and timestamps;
- start/completion time, duration, classified failure code, incident-opened time, and recovered time.

Do not store Turnstile secret keys, site credentials, mailbox credentials, customer input, submitted field values, email addresses used for testing, email subject/body, response bodies, screenshots containing submitted data, or real customer records. Logs and notifications must use only project/form identifiers, classified state, status, duration, attempt, and timestamps.

### Safe real-submission workflow

The first version should be supervised rather than autonomous. RetainerProof creates a due check and test ID; the maintainer opens the real form in a normal browser, enters dedicated non-customer test data kept outside RetainerProof, and completes Turnstile normally. The maintainer then confirms the four checkpoints in RetainerProof. A Turnstile request for human interaction is `manual_required`, not a failure. Automatic WordPress or mailbox verification requires a separate generic connector design and explicit approval; it must not introduce per-project copied code or store credentials in RetainerProof.

### H-KKS pilot

After approval, configure the five existing H-KKS forms as data in the shared feature and run this sequence:

1. Baseline all five forms with a non-submitting check and review any selector/profile differences without changing the sites.
2. Run one supervised real-submission cycle across the five forms, using a unique test ID per form, and confirm website acceptance, WordPress receipt, administrator notification, and auto-reply.
3. Enable daily non-submitting checks with a five-minute retry and consecutive-failure notification.
4. Enable a monthly supervised submission reminder for all five forms.
5. Map qualifying maintenance activities to a pending post-change submission check; do not automatically submit as a side effect of logging maintenance.
6. Review false positives, operator time, and missing checkpoints before allowing another project to use the same feature.

### Remaining rollout gates

- Decide the retention period for detailed form-check runs before expanding beyond the pilot. Account deletion continues to use the product-wide 30-day deletion schedule.
- Validate the bounded HTML detection profile against each pilot form. Dynamic browser rendering remains optional and must be cost-checked first.
- Approve the dedicated test identity/mailbox operating procedure outside RetainerProof.
- Approve who may perform and attest real submissions, the delivery wait window, and the overdue policy.
- Approve how post-change checks are created from maintenance records.
- Separately approve any future WordPress companion plugin, inbound email handler, Google/Gmail access, or other connector. No credentialed connector is part of the first phase.
- Approve H-KKS as the pilot, the five form URLs, the notification recipient, and the start date before creating schedules or sending mail.

The shared feature and database migration may be released under the current implementation approval. Do not register H-KKS schedules, create supervised H-KKS tasks, or send H-KKS test submissions until the five URLs, notification recipient, start date, dedicated test procedure, and operator are confirmed.
