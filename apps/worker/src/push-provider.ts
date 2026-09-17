import type { SafePushMessage } from "@yishu/domain/push";

export type PushResult =
  { status: "ok"; ticketId: string } | { status: "invalid" | "retry" | "failed" };
export type ReceiptResult = "ok" | "invalid" | "pending" | "failed";
export interface PushProvider {
  send(token: string, message: SafePushMessage): Promise<PushResult>;
  receipt(ticketId: string): Promise<ReceiptResult>;
}

/** The sole provider boundary. Tests inject a fake; no raw errors/responses escape. */
export class ExpoPushProvider implements PushProvider {
  constructor(private readonly accessToken?: string) {}
  private async post(endpoint: string, body: unknown): Promise<unknown> {
    const response = await fetch(`https://exp.host/--/api/v2/push/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("push_provider_unavailable");
    return response.json();
  }
  async send(token: string, message: SafePushMessage): Promise<PushResult> {
    try {
      const response = (await this.post("send", { to: token, sound: "default", ...message })) as {
        data?: { status?: string; id?: string; details?: { error?: string } };
      };
      const ticket = response.data;
      if (ticket?.status === "ok" && typeof ticket.id === "string")
        return { status: "ok", ticketId: ticket.id };
      if (ticket?.details?.error === "DeviceNotRegistered") return { status: "invalid" };
      if (ticket?.details?.error === "MessageTooBig") return { status: "failed" };
      return { status: "retry" };
    } catch {
      return { status: "retry" };
    }
  }
  async receipt(ticketId: string): Promise<ReceiptResult> {
    try {
      const response = (await this.post("getReceipts", { ids: [ticketId] })) as {
        data?: Record<string, { status?: string; details?: { error?: string } }>;
      };
      const receipt = response.data?.[ticketId];
      if (!receipt) return "pending";
      if (receipt.details?.error === "DeviceNotRegistered") return "invalid";
      return receipt.status === "ok" ? "ok" : "failed";
    } catch {
      return "pending";
    }
  }
}
