export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof payload.error === "string"
        ? payload.error
        : `Request failed (${response.status})`,
      response.status,
    );
  }

  return payload as T;
}
