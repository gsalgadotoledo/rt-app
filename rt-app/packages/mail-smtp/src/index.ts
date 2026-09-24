import nodemailer from "nodemailer";
import type { Mailer } from "@gsalgadotoledo/rt-app-auth";
import { HttpError } from "@gsalgadotoledo/rt-app-contracts";

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
}

/** What the mailer needs from a nodemailer transport (injectable for tests). */
export interface SmtpTransport {
  sendMail(message: SmtpMessage & { from: string }): Promise<unknown>;
}

/**
 * Parse SMTP_URL. `smtps://user:pass@host:465` (implicit TLS) or `smtp://user:pass@host:587`
 * (STARTTLS, required). Plain-text SMTP is refused so credentials never cross the network in clear.
 */
export function smtpOptions(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("SMTP_URL must be a URL like smtps://user:password@smtp.example.com:465");
  }
  if (!["smtp:", "smtps:"].includes(parsed.protocol)) throw new Error("SMTP_URL must use smtp:// or smtps://");
  const secure = parsed.protocol === "smtps:";
  return {
    host: parsed.hostname,
    port: Number(parsed.port || (secure ? 465 : 587)),
    secure,
    requireTLS: !secure,
    auth: parsed.username ? { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/** SMTP mailer for deployments outside AWS (Resend, Postmark, SendGrid, Mailgun SMTP…). */
export class SmtpMailer implements Mailer {
  private transport: SmtpTransport;

  constructor(
    private options: { url: string; from: string; transport?: SmtpTransport },
  ) {
    if (!options.from) throw new Error("MAIL_FROM is required");
    this.transport = options.transport ?? nodemailer.createTransport(smtpOptions(options.url));
  }

  /** Send a message. Provider errors become 503 without echoing credentials or server replies. */
  async send(message: SmtpMessage) {
    try {
      await this.transport.sendMail({ from: this.options.from, ...message });
    } catch {
      throw new HttpError(503, "Email delivery is temporarily unavailable");
    }
  }

  async sendCode(email: string, code: string, purpose: string) {
    await this.send({
      to: email,
      subject: `RT-App: ${purpose}`,
      text: `Your code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`,
    });
  }
}
