import { createHash } from "node:crypto";
import { structuredLog } from "./redaction.js";

/**
 * What the portal needs from "send an email", and nothing about who carries it.
 *
 * A mailer is configured from the architecture profile's `web` block
 * (`email_provider`, `email_api_key_secret_ref`, `email_from`); with none the
 * portal's sign-up and forgot-password routes answer 503 rather than pretend.
 * Implementations THROW when the message was not accepted — a caller that gets
 * no error may tell the person to check their inbox.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** A send that failed. Carries the HTTP status only: never the message, the address or the key. */
export class MailSendError extends Error {
  constructor(public readonly status: number | null) {
    super(status === null ? "MAIL_SEND_FAILED: no response" : `MAIL_SEND_FAILED: provider answered ${status}`);
    this.name = "MailSendError";
  }
}

const RESEND_URL = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;

/** Resend's HTTP API: POST /emails with a bearer key. `fetchImpl` is for tests. */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: MailMessage): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      throw new MailSendError(null);
    }
    if (!response.ok) throw new MailSendError(response.status);
  }
}

/**
 * Sends nothing. It keeps what it was given in `outbox` (tests read the link
 * out of it) and writes ONE log line per message that names the subject and a
 * digest of the recipient — never the body, which holds the one-time link.
 *
 * `echo` is for a development stack and nothing else: it also writes the whole
 * message to the log so a developer can click the link. The profile validator
 * refuses `email_provider: "log"` in production, and server.ts turns `echo` on
 * only for `environment: "development"`.
 */
export class LogMailer implements Mailer {
  readonly outbox: MailMessage[] = [];

  constructor(private readonly options: { log?: (line: string) => void; echo?: boolean } = {}) {}

  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
    const log = this.options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
    const recipient = `sha256:${createHash("sha256").update(message.to.trim().toLowerCase()).digest("hex").slice(0, 12)}`;
    log(structuredLog("info", "mailer.log_only", { subject: message.subject, to_digest: recipient, delivered: false }));
    if (this.options.echo) log(`--- mailer.log_only (development) to ${message.to}\n${message.subject}\n${message.text}\n---`);
  }
}
