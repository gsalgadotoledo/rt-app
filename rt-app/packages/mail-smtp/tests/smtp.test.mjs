import test from "node:test";
import assert from "node:assert/strict";
import { SmtpMailer, smtpOptions } from "@gsalgadotoledo/rt-app-mail-smtp";

test("SMTP URLs require TLS and decode credentials", () => {
  assert.deepEqual(
    (({ host, port, secure, requireTLS, auth }) => ({ host, port, secure, requireTLS, auth }))(smtpOptions("smtps://re%40send:p%3Ass@smtp.resend.com")),
    { host: "smtp.resend.com", port: 465, secure: true, requireTLS: false, auth: { user: "re@send", pass: "p:ss" } },
  );
  const starttls = smtpOptions("smtp://u:p@smtp.example.com:2525");
  assert.deepEqual([starttls.port, starttls.secure, starttls.requireTLS, starttls.disableFileAccess, starttls.disableUrlAccess], [2525, false, true, true, true]);
  assert.equal(smtpOptions("smtp://relay.internal").auth, undefined);
  assert.equal(smtpOptions("smtp://relay.internal").port, 587);
  assert.throws(() => smtpOptions("http://smtp.example.com"), /smtp:\/\/ or smtps:\/\//);
  assert.throws(() => smtpOptions("not a url"), /must be a URL/);
});

test("sends codes from MAIL_FROM and hides provider errors", async () => {
  const sent = [];
  const mailer = new SmtpMailer({ url: "smtps://u:p@smtp.example.com", from: "App <no-reply@example.com>", transport: { sendMail: async (m) => sent.push(m) } });
  await mailer.sendCode("ana@example.com", "123456", "Sign in");
  assert.deepEqual(sent[0], { from: "App <no-reply@example.com>", to: "ana@example.com", subject: "RT-App: Sign in", text: "Your code is 123456. It expires in 10 minutes. If you did not request it, ignore this email." });
  const failing = new SmtpMailer({ url: "smtps://u:secretpass@smtp.example.com", from: "a@example.com", transport: { sendMail: async () => { throw new Error("535 auth failed for secretpass"); } } });
  await assert.rejects(failing.send({ to: "x@example.com", subject: "s", text: "t" }), (e) => e.status === 503 && !e.message.includes("secretpass"));
  assert.throws(() => new SmtpMailer({ url: "smtps://h", from: "" }), /MAIL_FROM is required/);
  assert.ok(new SmtpMailer({ url: "smtps://u:p@smtp.example.com", from: "a@example.com" }), "real transport is created lazily without connecting");
});
