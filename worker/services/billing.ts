import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import Stripe from "stripe";
import { billingEvents, subscriptions } from "../db/schema";
import { sha256 } from "../lib/crypto";

export type BillingPlan = "starter" | "freelancer";
export type BillingInterval = "monthly" | "yearly";

export function getStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY);
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
  const stripe = getStripe(env);
  const checkout = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    managed_payments: { enabled: true },
    success_url: `${env.APP_URL}/app/billing?checkout=success`,
    cancel_url: `${env.APP_URL}/pricing?checkout=canceled`,
    customer_email: input.email,
    client_reference_id: input.workspaceId,
    metadata: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      plan: input.plan,
    },
  });
  if (!checkout.url) throw new Error("CHECKOUT_URL_MISSING");
  return checkout.url;
}

export async function createReservationCheckout(
  env: Env,
  input: { workspaceId: string; userId: string; email: string },
): Promise<string> {
  if (!env.STRIPE_FOUNDING_PRICE_ID) throw new Error("FOUNDING_PRICE_NOT_CONFIGURED");
  const checkout = await getStripe(env).checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: env.STRIPE_FOUNDING_PRICE_ID, quantity: 1 }],
    managed_payments: { enabled: true },
    success_url: `${env.APP_URL}/app?reservation=success`,
    cancel_url: `${env.APP_URL}/pricing?reservation=canceled`,
    customer_email: input.email,
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
  });
  if (!checkout.url) throw new Error("CHECKOUT_URL_MISSING");
  return checkout.url;
}

export async function handleStripeWebhook(env: Env, request: Request): Promise<void> {
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

  if (event.type === "checkout.session.completed") {
    const checkout = event.data.object;
    const workspaceId = checkout.client_reference_id ?? checkout.metadata?.workspaceId;
    const plan = checkout.metadata?.plan === "freelancer" ? "freelancer" : "starter";
    if (workspaceId && checkout.metadata?.kind === "founding_reservation") {
      await db
        .update(subscriptions)
        .set({
          providerCustomerId: typeof checkout.customer === "string" ? checkout.customer : null,
          status: "trialing",
          plan: "founding",
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.workspaceId, workspaceId));
    } else if (workspaceId && typeof checkout.subscription === "string") {
      await db
        .update(subscriptions)
        .set({
          providerCustomerId: typeof checkout.customer === "string" ? checkout.customer : null,
          providerSubscriptionId: checkout.subscription,
          status: "active",
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
    await db
      .update(subscriptions)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.providerSubscriptionId, subscription.id));
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
          .where(eq(subscriptions.workspaceId, workspaceId));
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
