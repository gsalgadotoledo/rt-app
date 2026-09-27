// Subjects: mail-local (LocalSmtpMailer + LocalMailbox capture + mailConfig), mail-smtp
// (SmtpMailer, smtpOptions). See spec/contracts/mail-local.contract.yaml and mail-smtp.contract.yaml.
//
// Mail is delivered to an in-process SMTP sink on 127.0.0.1 (never the network). The sink decodes
// what it receives the same way in every host (hosts/python/mail.py, contract-host/mail.go):
//   delivered() → [{mailFrom, rcptTo, smtputf8, headers, contentType, text, html}]
// headers holds every header except Date, Message-ID, MIME-Version, Content-Type and
// Content-Transfer-Encoding, by lower-case name (a repeated header becomes a list), each value
// unfolded (CRLF before whitespace removed), with one leading space removed and RFC 2047 encoded
// words decoded (whitespace between two encoded words dropped). Bodies are decoded by
// Content-Transfer-Encoding as UTF-8, CRLF becomes LF and one final LF is removed; a
// multipart/alternative body yields its text/plain and text/html parts.
import { createServer } from "node:net";
import { once } from "node:events";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { LocalSmtpMailer } from "@gsalgadotoledo/rt-app-mail-local";
import { mailConfig } from "@gsalgadotoledo/rt-app-mail-local/runtime";
import { SmtpMailer, smtpOptions } from "@gsalgadotoledo/rt-app-mail-smtp";

// Commands recorded by commands(); QUIT, RSET and NOOP are housekeeping and not recorded.
const VERBS = new Set(["EHLO", "HELO", "STARTTLS", "AUTH", "MAIL", "RCPT", "DATA"]);
const HIDDEN = new Set(["date", "message-id", "mime-version", "content-type", "content-transfer-encoding"]);

// --- the sink's decoder (identical in every host) --------------------------------------------

/** Decode RFC 2047 encoded words; whitespace between two adjacent encoded words is dropped. */
export function decodeWords(value) {
  let out = "", last = 0, pending = [];
  const flush = () => {
    if (pending.length) out += Buffer.concat(pending).toString("utf8");
    pending = [];
  };
  for (const match of value.matchAll(/=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=/g)) {
    const between = value.slice(last, match.index);
    // Adjacent encoded words join (their bytes may split a character); other text stays.
    if (!(pending.length && /^[ \t]*$/.test(between))) {
      flush();
      out += between;
    }
    const [, , encoding, text] = match;
    pending.push(encoding.toUpperCase() === "B"
      ? Buffer.from(text, "base64")
      : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1"));
    last = match.index + match[0].length;
  }
  flush();
  return out + value.slice(last);
}

/** Header block → [[lower-case name, raw value]] with folding removed. */
function headerFields(block) {
  const fields = [];
  for (const line of block.split("\r\n")) {
    if (/^[ \t]/.test(line) && fields.length) fields.at(-1)[1] += line;
    else if (line) {
      const colon = line.indexOf(":");
      if (colon > 0) fields.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1)]);
    }
  }
  return fields.map(([name, value]) => [name, value.startsWith(" ") ? value.slice(1) : value]);
}

function decodeBody(body, encoding) {
  let bytes;
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "base64":
      bytes = Buffer.from(body.replace(/[^A-Za-z0-9+/]/g, ""), "base64");
      break;
    case "quoted-printable":
      bytes = Buffer.from(body.replace(/=\r\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
      break;
    default:
      bytes = Buffer.from(body, "latin1");
  }
  return bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
}

function mediaType(value) {
  return (value ?? "text/plain").split(";")[0].trim().toLowerCase();
}

function parameter(value, name) {
  const match = (value ?? "").match(new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i"));
  return match ? match[1] ?? match[2] : undefined;
}

/** A message as received (latin1 text of the DATA bytes, dot-unstuffed) → the decoded view. */
export function decodeMessage(data) {
  const split = data.indexOf("\r\n\r\n");
  const head = split < 0 ? data : data.slice(0, split), body = split < 0 ? "" : data.slice(split + 4);
  const fields = headerFields(head);
  const field = (name) => fields.find(([n]) => n === name)?.[1];
  const headers = {};
  for (const [name, raw] of fields) {
    if (HIDDEN.has(name)) continue;
    const value = decodeWords(Buffer.from(raw, "latin1").toString("utf8"));
    headers[name] = name in headers ? [].concat(headers[name], value) : value;
  }
  const contentType = mediaType(field("content-type"));
  let text = null, html = null;
  if (contentType.startsWith("multipart/")) {
    const boundary = parameter(field("content-type"), "boundary") ?? "";
    for (const part of body.split("--" + boundary).slice(1)) {
      if (part.startsWith("--")) break;
      const content = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
      const at = content.indexOf("\r\n\r\n");
      const partFields = headerFields(at < 0 ? content : content.slice(0, at));
      const partField = (name) => partFields.find(([n]) => n === name)?.[1];
      const decoded = decodeBody(at < 0 ? "" : content.slice(at + 4), partField("content-transfer-encoding"));
      const type = mediaType(partField("content-type"));
      if (type === "text/plain") text = decoded;
      else if (type === "text/html") html = decoded;
    }
  } else {
    const decoded = decodeBody(body, field("content-transfer-encoding"));
    if (contentType === "text/html") html = decoded;
    else text = decoded;
  }
  return { headers, contentType, text, html };
}

/** The address of "MAIL FROM:<a> PARAMS" / "RCPT TO:<a>"; params after the path. */
function path(argument) {
  const text = argument.trim();
  if (!text.startsWith("<")) return { address: text.split(" ")[0], params: text.split(" ").slice(1) };
  const end = text.lastIndexOf(">");
  return { address: text.slice(1, end), params: text.slice(end + 1).trim().split(/\s+/).filter(Boolean) };
}

/**
 * An SMTP sink on 127.0.0.1. Options: starttls (advertise STARTTLS; it is never accepted),
 * auth (advertise AUTH PLAIN LOGIN), reject (RCPT addresses answered 550).
 */
export async function smtpSink({ starttls = false, auth = false, reject = [] } = {}) {
  const messages = [], commands = [], sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0), data = false, envelope = { from: null, to: [], smtputf8: false };
    const reply = (line) => socket.write(line + "\r\n");
    socket.write("220 rt-app-sink ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (data) {
          const end = buffer.indexOf("\r\n.\r\n");
          const empty = buffer.subarray(0, 3).toString("latin1") === ".\r\n";
          if (end < 0 && !empty) return;
          const raw = empty ? "" : buffer.subarray(0, end + 2).toString("latin1");
          buffer = buffer.subarray(empty ? 3 : end + 5);
          data = false;
          const unstuffed = raw.split("\r\n").map((line) => (line.startsWith("..") ? line.slice(1) : line)).join("\r\n");
          messages.push({ mailFrom: envelope.from, rcptTo: envelope.to, smtputf8: envelope.smtputf8, ...decodeMessage(unstuffed) });
          envelope = { from: null, to: [], smtputf8: false };
          reply("250 2.0.0 queued");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 2);
        const verb = line.split(" ")[0].split(":")[0].toUpperCase();
        if (VERBS.has(verb)) commands.push(verb);
        const argument = line.slice(line.indexOf(":") + 1);
        if (verb === "EHLO") {
          const lines = ["rt-app-sink", "8BITMIME", "SMTPUTF8", ...(starttls ? ["STARTTLS"] : []), ...(auth ? ["AUTH PLAIN LOGIN"] : [])];
          lines.forEach((l, i) => reply(`250${i === lines.length - 1 ? " " : "-"}${l}`));
        } else if (verb === "HELO") reply("250 rt-app-sink");
        else if (verb === "MAIL") {
          const { address, params } = path(argument);
          envelope = { from: address, to: [], smtputf8: params.some((p) => p.toUpperCase() === "SMTPUTF8") };
          reply("250 2.1.0 ok");
        } else if (verb === "RCPT") {
          const { address } = path(argument);
          if (reject.includes(address)) reply("550 5.1.1 rejected");
          else {
            envelope.to.push(address);
            reply("250 2.1.5 ok");
          }
        } else if (verb === "DATA") {
          if (!envelope.to.length) reply("554 5.5.1 no valid recipients");
          else {
            data = true;
            reply("354 end with .");
          }
        } else if (verb === "QUIT") {
          reply("221 2.0.0 bye");
          socket.end();
        } else if (verb === "RSET") {
          envelope = { from: null, to: [], smtputf8: false };
          reply("250 ok");
        } else if (verb === "NOOP") reply("250 ok");
        else if (verb === "STARTTLS") reply("454 4.7.0 TLS not available");
        else if (verb === "AUTH") reply("535 5.7.8 authentication refused");
        else reply("502 5.5.2 unknown command");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    messages,
    commands,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// --- subjects --------------------------------------------------------------------------------

const DEFAULT_NOW = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
const given = (value) => (value === null ? undefined : value);

/** Run `build` with NODE_ENV set as init.nodeEnv asks (the TypeScript classes read process.env). */
function withNodeEnv(nodeEnv, build) {
  const previous = process.env.NODE_ENV;
  if (nodeEnv === undefined) return build();
  process.env.NODE_ENV = nodeEnv;
  try {
    return build();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

/** mail-local: init {port?, defaultPort?, capture?, now?, nodeEnv?, sink?: {starttls, auth, reject}}. */
async function mailLocal(init) {
  const sink = await smtpSink(init.sink ?? {});
  let now = init.now ? Date.parse(init.now) : DEFAULT_NOW;
  const capture = init.capture === false ? undefined : new LocalMailbox({ now: () => now });
  let mailer;
  try {
    mailer = withNodeEnv(given(init.nodeEnv), () =>
      new LocalSmtpMailer({ port: init.defaultPort ? undefined : typeof init.port === "number" || typeof init.port === "string" ? init.port : sink.port, capture }));
  } catch (error) {
    await sink.close();
    throw error;
  }
  return {
    send: async (message) => (await mailer.send(message), null),
    sendCode: async (email, code, purpose) => (await mailer.sendCode(email, code, purpose), null),
    delivered: () => sink.messages,
    commands: () => sink.commands,
    mailbox: () => capture?.messages ?? null,
    stopSink: async () => (await sink.close(), null),
    setNow: (iso) => ((now = Date.parse(iso)), null),
    mailConfig: (env) => mailConfig(env ?? {}),
    close: () => sink.close(),
  };
}

/**
 * mail-smtp: init {url, from, transport: "fake" | "failing" | "sink" | "real", sink?}.
 * fake records what the mailer hands its transport; failing throws "535 auth failed for
 * <password>"; sink sends with the real transport to the local sink (url host/port replaced by
 * the sink); real builds the real transport from url without connecting.
 */
async function mailSmtp(init) {
  const sent = [];
  const kind = init.transport ?? "fake";
  const sink = kind === "sink" ? await smtpSink(init.sink ?? {}) : undefined;
  const transports = {
    fake: { sendMail: async (message) => void sent.push(message) },
    failing: { sendMail: async () => { throw new Error(`535 auth failed for ${init.url}`); } },
  };
  let url = init.url;
  if (sink) url = url.replace("{port}", String(sink.port));
  let mailer;
  try {
    mailer = new SmtpMailer({ url, from: init.from, transport: transports[kind] });
  } catch (error) {
    await sink?.close();
    throw error;
  }
  return {
    send: async (message) => (await mailer.send(message), null),
    sendCode: async (email, code, purpose) => (await mailer.sendCode(email, code, purpose), null),
    sent: () => sent,
    delivered: () => sink?.messages ?? [],
    commands: () => sink?.commands ?? [],
    smtpOptions: (value) => smtpOptions(value),
    close: () => sink?.close(),
  };
}

export const subjects = { "mail-local": mailLocal, "mail-smtp": mailSmtp };
