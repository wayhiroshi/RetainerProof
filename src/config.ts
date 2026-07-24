export const brand = {
  name: import.meta.env.VITE_APP_NAME || "RetainerProof",
  message: "Turn invisible maintenance into client-visible value.",
  supportEmail: import.meta.env.VITE_SUPPORT_EMAIL || "support@example.com",
} as const;
