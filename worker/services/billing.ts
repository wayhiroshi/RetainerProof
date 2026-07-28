import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import Stripe from "stripe";
import { billingEvents, subscriptions } from "../db/schema";
import { sha256 } from "../lib/crypto";

export type BillingPlan = "starter" | "freelancer";
export type BillingInterval = "monthly" | "yearly";

export function getStripe(env: Env): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_NOT_CONFIGURED");
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-06-24.dahlia",
    maxNetworkRetries: 2,
    timeout: 10_000,
  });
}

export async function createCheckout(
  env: Env,
  input: {
    workspaceId: string;
    userId: string;
    email: string;
    plan: BillingPlan;
    interval: BillingInterval;
  },
): Promise<string> {
  const priceId = priceFor(env, input.plan, input.interval);
  if (!priceId) throw new Error("PRICE_NOT_CONFIGURED");
  const db = drizzle(env.DB);
  const current = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, input.workspaceId))
    .get();
  if (!current) throw new Error("SUBSCRIPTION_NOT_FOUND");
  if (
    current.providerSubscriptionId &&
    ["trialing", "active", "past_due"].includes(current.status)
  ) {
    throw new Error("SUBSCRIPTION_ALREADY_ACTIVE");
  }
  const applyFoundingCredit = current.plan === "founding" && current.status === "trialing";
  if (applyFoundingCredit && !env.STRIPE_FOUNDING_CREDIT_COUPON_ID) {
    throw new Error("FOUNDING_CREDIT_NOT_CONFIGURED");
  }
  const stripe = getStripe(env);
  const checkout = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      managed_payments: { enabled: true },
      success_url: `${env.APP_URL}/app/billing?checkout=success`,
      cancel_url: `${env.APP_URL}/pricing?checkout=canceled`,
      ...(current.providerCustomerId
        ? { customer: current.providerCustomerId }
        : { customer_email: input.email }),
      client_reference_id: input.workspaceId,
      metadata: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        plan: input.plan,
        interval: input.interval,
      },
      subscription_data: {
        metadata: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          plan: input.plan,
          interval: input.interval,
        },
      },
      ...(applyFoundingCredit
        ? { discounts: [{ coupon: env.STRIPE_FOUNDING_CREDIT_COUPON_ID }] }
        : {}),
    },
    { idempotencyKey: `subscription-checkout-${crypto.randomUUID()}` },
  );
  if (!checkout.url) throw new Error("CHECKOUT_URL_MISSING");
  return checkout.url;
}

export async function createReservationCheckout(
  env: Env,
  input: { workspaceId: string; userId: string; email: string },
): Promise<string> {
  if (!env.STRIPE_FOUNDING_PRICE_ID) throw new Error("FOUNDING_PRICE_NOT_CONFIGURED");
  const db = drizzle(env.DB);
  const current = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, input.workspaceId))
    .get();
  if (!current) throw new Error("SUBSCRIPTION_NOT_FOUND");
  if (current.status !== "unpaid" || current.plan === "founding") {
    throw new Error("RESERVATION_ALREADY_PURCHASED");
  }
  const checkout = await getStripe(env).checkout.sessions.create(
    {
      mode: "payment",
      line_items: [{ price: env.STRIPE_FOUNDING_PRICE_ID, quantity: 1 }],
      managed_payments: { enabled: true },
      success_url: `${env.APP_URL}/app?reservation=success`,
      cancel_url: `${env.APP_URL}/pricing?reservation=canceled`,
      ...(current.providerCustomerId
        ? { customer: current.providerCustomerId }
        : { customer_email: input.email, customer_creation: "always" as const }),
      client_reference_id: input.workspaceId,
      metadata: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        plan: "founding",
        kind: "founding_reservation",
      },
      payment_intent_data: {
        metadata: {
          workspaceId: input.workspaceId,
          kind: "founding_reservation",
        },
      },
    },
    { idempotencyKey: `founding-checkout-${crypto.randomUUID()}` },
  );
  if (!checkout.url) throw new Error("CHECKOUT_URL_MISSING");
  return checkout.url;
}

export async function handleStripeWebhook(env: Env, request: Request): Promise<void> {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_NOT_CONFIGURED");
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) throw new Error("STRIPE_SIGNATURE_MISSING");
  const stripe = getStripe(env);
  const event = await stripe.webhooks.constructEventAsync(body, signature, env.STRIPE_WEBHOOK_SECRET);
  const db = drizzle(env.DB);
  const alreadyProcessed = await db
    .select({ id: billingEvents.id })
    .from(billingEvents)
    .where(eq(billingEvents.providerEventId, event.id))
    .get();
  if (alreadyProcessed) return;

  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded" ||
    event.type === "checkout.session.async_payment_failed"
  ) {
    const checkout = event.data.object;
    const workspaceId = checkout.client_reference_id ?? checkout.metadata?.workspaceId;
    const plan = checkout.metadata?.plan === "freelancer" ? "freelancer" : "starter";
    const paymentSucceeded =
      event.type === "checkout.session.async_payment_succeeded" ||
      (event.type === "checkout.session.completed" && checkout.payment_status !== "unpaid");
    if (workspaceId && checkout.metadata?.kind === "founding_reservation") {
      await db
        .update(subscriptions)
        .set({
          providerCustomerId: typeof checkout.customer === "string" ? checkout.customer : null,
          status: paymentSucceeded ? "trialing" : "unpaid",
          ...(paymentSucceeded ? { plan: "founding" as const } : {}),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.workspaceId, workspaceId));
    } else if (workspaceId && typeof checkout.subscription === "string") {
      await db
        .update(subscriptions)
        .set({
          providerCustomerId: typeof checkout.customer === "string" ? checkout.customer : null,
          providerSubscriptionId: checkout.subscription,
          status: paymentSucceeded ? "active" : "unpaid",
          plan,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.workspaceId, workspaceId));
    }
  }

  if (
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted" ||
    event.type === "customer.subscription.paused" ||
    event.type === "customer.subscription.resumed"
  ) {
    const subscription = event.data.object;
    const status = normalizeStatus(subscription.status);
    const workspaceId = subscription.metadata.workspaceId;
    const plan =
      subscription.metadata.plan === "freelancer"
        ? "freelancer"
        : subscription.metadata.plan === "starter"
          ? "starter"
          : undefined;
    const currentPeriodEnd = subscription.items.data.length
      ? new Date(Math.max(...subscription.items.data.map((item) => item.current_period_end)) * 1_000)
      : null;
    await db
      .update(subscriptions)
      .set({
        status,
        ...(plan ? { plan } : {}),
        currentPeriodEnd,
        updatedAt: new Date(),
      })
      .where(
        workspaceId
          ? eq(subscriptions.workspaceId, workspaceId)
          : eq(subscriptions.providerSubscriptionId, subscription.id),
      );
  }

  if (event.type === "charge.refunded") {
    const charge = event.data.object;
    if (charge.amount_refunded >= charge.amount && typeof charge.payment_intent === "string") {
      const paymentIntent = await stripe.paymentIntents.retrieve(charge.payment_intent);
      const workspaceId = paymentIntent.metadata.workspaceId;
      if (workspaceId && paymentIntent.metadata.kind === "founding_reservation") {
        await db
          .update(subscriptions)
          .set({ status: "unpaid", updatedAt: new Date() })
          .where(
            and(
              eq(subscriptions.workspaceId, workspaceId),
              eq(subscriptions.plan, "founding"),
              isNull(subscriptions.providerSubscriptionId),
            ),
          );
      }
    }
  }

  await db.insert(billingEvents).values({
    id: crypto.randomUUID(),
    providerEventId: event.id,
    eventType: event.type,
    payloadHash: await sha256(body),
    processedAt: new Date(),
  });
}

export async function clientLimitForWorkspace(env: Env, workspaceId: string): Promise<number> {
  const db = drizzle(env.DB);
  const subscription = await db
    .select({ plan: subscriptions.plan })
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, workspaceId))
    .get();
  return subscription?.plan === "freelancer" ? 15 : 3;
}

export async function cancelWorkspaceSubscription(env: Env, workspaceId: string): Promise<void> {
  const db = drizzle(env.DB);
  const subscription = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, workspaceId))
    .get();
  if (!subscription) throw new Error("SUBSCRIPTION_NOT_FOUND");
  if (!subscription.providerSubscriptionId) throw new Error("NO_RECURRING_SUBSCRIPTION");
  await getStripe(env).subscriptions.cancel(subscription.providerSubscriptionId);
  await db
    .update(subscriptions)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(eq(subscriptions.workspaceId, workspaceId));
}

function priceFor(env: Env, plan: BillingPlan, interval: BillingInterval): string {
  if (plan === "starter" && interval === "monthly") return env.STRIPE_STARTER_MONTHLY_PRICE_ID;
  if (plan === "starter" && interval === "yearly") return env.STRIPE_STARTER_YEARLY_PRICE_ID;
  if (plan === "freelancer" && interval === "monthly") return env.STRIPE_FREELANCER_MONTHLY_PRICE_ID;
  return env.STRIPE_FREELANCER_YEARLY_PRICE_ID;
}

function normalizeStatus(status: Stripe.Subscription.Status): "trialing" | "active" | "past_due" | "canceled" | "unpaid" {
  if (status === "trialing" || status === "active" || status === "past_due" || status === "unpaid") return status;
  return "canceled";
}
