import type { IdentityProvider } from './provider.js';
import {AuthVault, totpSecret, totpStep} from './totp.js';
export type { IdentityProvider } from './provider.js';
import type { NoSQL as Store } from "@gsalgadotoledo/rt-app-nosql";
import { migrations } from "./migrations.js";
import { rateLimit } from "./limits.js";
import { RefreshSessions, sessionLive, parseRefreshToken, INVALID_REFRESH, type SessionClient } from "./sessions.js";
export * from "./sessions.js";
export { rateLimit } from "./limits.js";
import { createHmac, randomInt, timingSafeEqual, randomUUID } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  type Feature,
  type Row,
  HttpError,
  Conflict,
  type Actor,
  emailAddress,
  publicUser,
  viewUser,
  schemaMigration,
  epochMs,
  type Clock,
} from "@gsalgadotoledo/rt-app-contracts";
import { Users, hashPassword, verifyPassword, validatePassword } from "@gsalgadotoledo/rt-app-users";
import { JwtTokens } from "@gsalgadotoledo/rt-app-jwt";
export interface Mailer {
  send?(message:{to:string;subject:string;text:string}):Promise<void>;
  sendCode(email: string, code: string, purpose: string): Promise<void>;
}
export class LocalMailbox implements Mailer {
  async send(message:{to:string;subject:string;text:string}){this.messages.unshift({email:message.to,code:message.text,purpose:message.subject,at:new Date().toISOString()});this.messages=this.messages.slice(0,30);}
  messages: { email: string; code: string; purpose: string; at: string }[] = [];
  async sendCode(email: string, code: string, purpose: string) {
    this.messages.unshift({
      email,
      code,
      purpose,
      at: new Date().toISOString(),
    });
    this.messages = this.messages.slice(0, 30);
  }
}
export class SesMailer implements Mailer {
  async send(message:{to:string;subject:string;text:string}){await this.client.send(new SendEmailCommand({FromEmailAddress:this.from,Destination:{ToAddresses:[message.to]},Content:{Simple:{Subject:{Data:message.subject},Body:{Text:{Data:message.text}}}}}));}
  private client = new SESv2Client({});
  constructor(private from: string) {
    if (!from) throw new Error("MAIL_FROM is required");
  }
  async sendCode(email: string, code: string, purpose: string) {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: `RT-App: ${purpose}` },
            Body: {
              Text: {
                Data: `Your code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`,
              },
            },
          },
        },
      }),
    );
  }
}
export interface AuthOptions {
  /**
   * Injectable clock (epoch ms or Date) for rate-limit windows, code and challenge expiry and
   * TOTP steps; defaults to the system clock. Pass the same clock to JwtTokens.
   */
  now?: Clock;
  /** Absolute refresh-session lifetime from sign-in in ms (default 4 days). */
  sessionTtlMs?: number;
  /** Grace window for reusing the previous refresh token in ms (default 30 s). */
  refreshGraceMs?: number;
}
/** The User-Agent request header when it is a single string. */
function userAgent(request: { headers: Record<string, unknown> }) {
  const value = request.headers["user-agent"];
  return typeof value === "string" ? value : undefined;
}

export class Auth {
  constructor(
    private users: Users,
    private tokens: JwtTokens,
    private mail: Mailer,
    private secret: string,
    private provider?: IdentityProvider,
    private options: AuthOptions = {},
  ) {
    this.refreshSessions = new RefreshSessions(users.store, secret, {
      now: options.now,
      ttlMs: options.sessionTtlMs,
      graceMs: options.refreshGraceMs,
    });
  }

  /** Refresh sessions (rows SESSIONS#<userId>/<sessionId> and SESSION/<sessionId>). */
  readonly refreshSessions: RefreshSessions;

  private now() {
    return epochMs(this.options.now);
  }
  private get vault(){return new AuthVault(this.secret);}
  private get store() {
    return this.users.store;
  }
  private digest(value: string) {
    return createHmac("sha256", this.secret).update(value).digest("hex");
  }
  /** Count one attempt for key in the current minute; 429 when max is reached (see limits.ts). */
  async limit(key: string, max: number) {
    await rateLimit(this.store, this.secret, this.now(), key, max);
  }

  /**
   * Resolve the Authorization header to an actor, checking the database on every request: the
   * user must exist, be active, use this credential provider and have the token's version. A
   * token with a sid claim also needs its refresh session to be live (one extra read), so
   * revoking a session cuts its access token immediately. Tokens without sid keep working.
   * Runs once at request start: work already running is never interrupted by expiry.
   */
  async actor(header?: string): Promise<Actor | undefined> {
    if (!header) return undefined;
    if (!header.startsWith("Bearer "))
      throw new HttpError(401, "Invalid token");
    const claims = await this.tokens.verify(header.slice(7));
    const user = await this.users.get(claims.id);
    if (!user || !user.data.active || user.data.tokenVersion !== claims.version || (user.data.credentialProvider ?? 'local') !== this.providerId)
      throw new HttpError(401, "Invalid session");
    if (claims.sid === undefined) return publicUser(user.data);
    if (!sessionLive(await this.refreshSessions.get(claims.id, claims.sid), this.now()))
      throw new HttpError(401, "Invalid session");
    return { ...publicUser(user.data), sessionId: claims.sid };
  }

  private get providerId() {
    return this.provider?.id ?? "local";
  }

  /** Build the session response for a user row and its refresh session. */
  private async respond(row: Row, refresh: { sessionId: string; refreshToken: string; expiresAt: number }) {
    return {
      token: await this.tokens.issue({ ...publicUser(row.data), sid: refresh.sessionId }),
      expiresIn: 900,
      refreshToken: refresh.refreshToken,
      refreshExpiresAt: new Date(refresh.expiresAt).toISOString(),
      sessionId: refresh.sessionId,
      user: viewUser(row.data),
    };
  }

  /** Start a refresh session for a user who just signed in and return the session response. */
  private async session(row: Row, client: SessionClient = {}) {
    const refresh = await this.refreshSessions.create(
      { id: row.data.id, tokenVersion: row.data.tokenVersion, provider: this.providerId },
      client,
    );
    return this.respond(row, refresh);
  }

  /** Whether a session row still matches its user in the database (the immediate cut-off). */
  private async sessionUser(session: Row) {
    const user = await this.users.get(session.data.userId);
    const valid =
      !!user &&
      user.data.active === true &&
      user.data.tokenVersion === session.data.tokenVersion &&
      (user.data.credentialProvider ?? "local") === session.data.provider &&
      session.data.provider === this.providerId;
    return valid ? user : undefined;
  }

  /**
   * POST /auth/refresh: rotate a refresh token and issue a new access token for the same session
   * (same absolute expiry). Limits refresh-ip:<ip> 60 then refresh-session:<sessionId> 10 per
   * minute; every failure is 401 "Invalid session".
   * @example refresh("<sessionId>.<secret>", "1.1.1.1")
   *   → {token, expiresIn: 900, refreshToken, refreshExpiresAt, sessionId, user}
   */
  async refresh(refreshToken: unknown, ip: string) {
    await this.limit(`refresh-ip:${ip}`, 60);
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw new HttpError(401, INVALID_REFRESH);
    await this.limit(`refresh-session:${parsed.sessionId}`, 10);
    let user: Row | undefined;
    const rotated = await this.refreshSessions.rotate(refreshToken, async (session) => {
      user = await this.sessionUser(session);
      return !!user;
    });
    return this.respond(user!, rotated);
  }

  /**
   * GET /auth/sessions: the live sessions of a user, newest first. Never returns secrets or
   * hashes. current marks the session of the calling access token.
   */
  async sessions(userId: string, currentSessionId?: string) {
    const user = await this.users.get(userId), now = this.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const items = (await this.refreshSessions.rows(userId))
      .filter((row) => sessionLive(row, now) && row.data.tokenVersion === user?.data.tokenVersion && row.data.provider === this.providerId)
      .sort((a, b) => b.data.createdAt - a.data.createdAt || (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0))
      .map((row) => ({
        id: row.sk,
        createdAt: iso(row.data.createdAt),
        lastUsedAt: iso(row.data.lastUsedAt),
        expiresAt: iso(row.data.expiresAt),
        current: row.sk === currentSessionId,
        ip: row.data.ip ?? null,
        userAgent: row.data.userAgent ?? null,
      }));
    return { items };
  }

  /** DELETE /auth/sessions/:id: revoke one of the caller's own live sessions, else 404. */
  async revokeSession(userId: string, sessionId: unknown) {
    const user = await this.users.get(userId);
    const row = typeof sessionId === "string" && sessionId.length <= 100 ? await this.refreshSessions.get(userId, sessionId) : undefined;
    if (!row || row.data.tokenVersion !== user?.data.tokenVersion || !(await this.refreshSessions.revoke(userId, sessionId as string, "revoked")))
      throw new HttpError(404, "Session not found");
    return { ok: true };
  }

  /**
   * POST /auth/logout. Signs out the current session only (its refresh token and access token stop
   * working at once). With all === true, or for an access token without a session (sid), it signs
   * out everywhere as before: the identity provider logs out and tokenVersion is bumped, which
   * kills every session and access token of the user.
   */
  async logout(userId: string, sessionId?: string, all?: unknown) {
    if (all !== true && sessionId) {
      await this.refreshSessions.revoke(userId, sessionId, "logout");
      return { ok: true };
    }
    const row = await this.users.get(userId);
    if (!row) throw new HttpError(401, "Invalid session");
    if (this.provider) await this.provider.logout(row.data.id);
    await this.invalidate(row);
    return { ok: true };
  }

  async login(email: string, password: unknown, ip: string, userAgent?: string) {
    if (!(await this.settings()).values.passwordLogin)
      throw new HttpError(403, "Password sign-in is disabled");
    await this.limit(`login-ip:${ip}`, 30);
    await this.limit(`login:${email}`, 8);
    const row = await this.users.byEmail(email);
    if (this.provider) {
      if (!row?.data.active || row.data.credentialProvider !== this.provider.id) throw new HttpError(401, "Incorrect email or password");
      validatePassword(password);
      const result = await this.provider.password(row.data.id, password);
      if ('challenge' in result) return this.pending(row, 'totp', {providerSession:result.session});
      return this.session(row, { ip, userAgent });
    }
    const valid = await verifyPassword(
      password,
      row?.data.passwordHash ??
        `scrypt$00000000000000000000000000000000$${"00".repeat(64)}`,
    );
    if (!row || !row.data.active || !valid)
      throw new HttpError(401, "Incorrect email or password");
    if ((await this.store.get("MFA", row.data.id))?.data.enabled) return this.pending(row, 'totp', {});
    return this.session(row, { ip, userAgent });
  }
  async issue(email: string, purpose: "login" | "reset", ip: string) {
    if (purpose === "login" && !(await this.settings()).values.emailCodeLogin)
      throw new HttpError(403, "Email code sign-in is disabled");
    await this.limit(`mail-ip:${ip}`, 20);
    await this.limit(`mail:${email}`, 3);
    const user = await this.users.byEmail(email);
    const reply = () => ({message:"If the account supports this method, you will receive a code.", ...(this.provider && purpose === 'login' ? {challenge:'email',challengeId:randomUUID()} : {})});
    if (user?.data.active) {
      if (purpose === 'login' && await this.hasMfa(user.data.id))
        return reply();
      if (this.provider) {
        if (user.data.credentialProvider !== this.provider.id) return reply();
        if (purpose === 'reset') await this.provider.forgot(user.data.id);
        else return {...await this.pending(user,'email',{providerSession:await this.provider.emailCode(user.data.id)}),message:"If the account supports this method, you will receive a code."};
        return reply();
      }
      const code = String(randomInt(100000, 1000000));
      const sk = this.digest(`${purpose}:${email}`);
      const old = await this.store.get("CHALLENGE", sk);
      await this.store.transact([
        {
          row: {
            pk: "CHALLENGE",
            sk,
            version: (old?.version ?? 0) + 1,
            ttl: Math.floor(this.now() / 1000) + 600,
            data: {
              userId: user.data.id,
              hash: this.digest(`${purpose}:${email}:${code}`),
              attempts: 0,
              used: false,
              expires: this.now() + 600000,
              tokenVersion: user.data.tokenVersion,
            },
          },
          expected: old?.version ?? null,
        },
      ]);
      await this.mail.sendCode(email, code, purpose);
    }
    return reply();
  }
  async consume(
    email: string,
    code: unknown,
    purpose: "login" | "reset",
    ip: string,
    password?: unknown,
    challengeId?: string,
    userAgent?: string,
  ) {
    if (purpose === "login" && !(await this.settings()).values.emailCodeLogin)
      throw new HttpError(403, "Email code sign-in is disabled");
    await this.limit(`verify-ip:${ip}`, 30);
    await this.limit(`verify:${email}`, 8);
    if (typeof code !== "string" || !/^\d{6}$/.test(code))
      throw new HttpError(400, "Invalid code");
    if (this.provider) {
      const user = await this.users.byEmail(email);
      if (!user?.data.active || user.data.credentialProvider !== this.provider.id) throw new HttpError(400,"Invalid or expired code");
      if (purpose === 'reset') {
        validatePassword(password);
        await this.provider.reset(user.data.id, code, password);
        await this.invalidate(user);
        return {message:"Password updated. Sign in to continue."};
      }
      const pending = await this.readPending(challengeId, 'email');
      if(pending.data.userId !== user.data.id) throw new HttpError(400,"Invalid code");
      await this.provider.verifyEmailCode(user.data.id, this.vault.open(pending.data.sealed).providerSession, code);
      await this.finishPending(pending);
      return this.session(user, { ip, userAgent });
    }
    const sk = this.digest(`${purpose}:${email}`),
      row = await this.store.get("CHALLENGE", sk);
    if (
      !row ||
      row.data.used ||
      row.data.expires < this.now() ||
      row.data.attempts >= 5
    )
      throw new HttpError(400, "Invalid or expired code");
    const matches = timingSafeEqual(
      Buffer.from(row.data.hash, "hex"),
      Buffer.from(this.digest(`${purpose}:${email}:${code}`), "hex"),
    );
    if (!matches) {
      await this.store.transact([
        {
          row: {
            ...row,
            version: row.version + 1,
            data: { ...row.data, attempts: row.data.attempts + 1 },
          },
          expected: row.version,
        },
      ]);
      throw new HttpError(400, "Invalid or expired code");
    }
    const user = await this.users.get(row.data.userId);
    if (!user?.data.active || user.data.tokenVersion !== row.data.tokenVersion)
      throw new HttpError(400, "Invalid or expired code");
    const consumed = {
      row: {
        ...row,
        version: row.version + 1,
        data: { ...row.data, used: true },
      },
      expected: row.version,
    };
    if (purpose === "reset") {
      const passwordHash = await hashPassword(password);
      await this.store.transact([
        consumed,
        {
          row: {
            ...user,
            version: user.version + 1,
            data: {
              ...user.data,
              passwordHash,
              tokenVersion: user.data.tokenVersion + 1,
            },
          },
          expected: user.version,
        },
      ]);
      return { message: "Password updated. Sign in to continue." };
    }
    if(await this.hasMfa(user.data.id)) throw new HttpError(403,"Use your password and authenticator");
    await this.store.transact([consumed]);
    return this.session(user, { ip, userAgent });
  }
  async requestEmailChange(userId: string, email: string, ip: string) {
    await this.limit(`email-change-ip:${ip}`, 10);
    await this.limit(`email-change:${userId}`, 3);
    if (await this.users.byEmail(email))
      throw new HttpError(400, "This email address cannot be used");
    const code = String(randomInt(100000, 1000000)),
      sk = this.digest(`email-change:${userId}`),
      old = await this.store.get("CHALLENGE", sk);
    const user = await this.users.get(userId);
    if (!user?.data.active) throw new HttpError(401, "Invalid session");
    await this.store.transact([
      {
        row: {
          pk: "CHALLENGE",
          sk,
          version: (old?.version ?? 0) + 1,
          ttl: Math.floor(this.now() / 1000) + 600,
          data: {
            email,
            userId,
            hash: this.digest(`email-change:${userId}:${email}:${code}`),
            used: false,
            attempts: 0,
            expires: this.now() + 600000,
            tokenVersion: user.data.tokenVersion,
          },
        },
        expected: old?.version ?? null,
      },
    ]);
    await this.mail.sendCode(email, code, "email-change");
    return { message: "We sent a code to the new email address." };
  }
  async confirmEmailChange(userId: string, code: unknown, ip: string, userAgent?: string) {
    await this.limit(`email-confirm:${userId}`, 8);
    await this.limit(`email-confirm-ip:${ip}`, 20);
    if (typeof code !== "string" || !/^\d{6}$/.test(code))
      throw new HttpError(400, "Invalid code");
    const row = await this.store.get(
      "CHALLENGE",
      this.digest(`email-change:${userId}`),
    );
    if (
      !row ||
      row.data.used ||
      row.data.attempts >= 5 ||
      row.data.expires < this.now()
    )
      throw new HttpError(400, "Invalid or expired code");
    const match = timingSafeEqual(
      Buffer.from(row.data.hash, "hex"),
      Buffer.from(
        this.digest(`email-change:${userId}:${row.data.email}:${code}`),
        "hex",
      ),
    );
    if (!match) {
      await this.store.transact([
        {
          row: {
            ...row,
            version: row.version + 1,
            data: { ...row.data, attempts: row.data.attempts + 1 },
          },
          expected: row.version,
        },
      ]);
      throw new HttpError(400, "Invalid or expired code");
    }
    const user = await this.users.get(userId);
    if (!user?.data.active || user.data.tokenVersion !== row.data.tokenVersion)
      throw new HttpError(401, "Invalid session");
    const index = await this.store.get("EMAIL", user.data.email);
    if (!index) throw new Error("Email index missing");
    if(this.provider) await this.provider.changeEmail(userId,row.data.email);
    const updated = {
      ...user,
      version: user.version + 1,
      data: {
        ...user.data,
        email: row.data.email,
        tokenVersion: user.data.tokenVersion + 1,
      },
    };
    await this.store.transact([
      {
        row: {
          ...row,
          version: row.version + 1,
          data: { ...row.data, used: true },
        },
        expected: row.version,
      },
      { row: updated, expected: user.version },
      { row: index, expected: index.version, delete: true },
      {
        row: {
          pk: "EMAIL",
          sk: row.data.email,
          version: 1,
          data: { id: userId },
        },
        expected: null,
      },
    ]);
    return this.session(updated, { ip, userAgent });
  }
  private async invalidate(row:Row) {
    await this.store.transact([{row:{...row,version:row.version+1,data:{...row.data,tokenVersion:row.data.tokenVersion+1}},expected:row.version}]);
  }
  async hasMfa(id:string) {return this.provider ? this.provider.mfaStatus(id) : !!(await this.store.get('MFA',id))?.data.enabled;}
  private async pending(user:Row,kind:string,value:object) {
    const id=randomUUID();
    await this.store.transact([{row:{pk:'AUTH_FLOW',sk:id,version:1,ttl:Math.floor(this.now()/1000)+300,data:{userId:user.data.id,tokenVersion:user.data.tokenVersion,kind,expires:this.now()+300000,used:false,sealed:this.vault.seal(value)}},expected:null}]);
    return {challenge:kind,challengeId:id};
  }
  private async readPending(id:unknown,kind:string) {
    if(typeof id!=='string'||id.length>100) throw new HttpError(400,"Invalid challenge");
    const row=await this.store.get('AUTH_FLOW',id);
    if(!row||row.data.kind!==kind||row.data.used||row.data.expires<this.now()) throw new HttpError(400,"Invalid or expired challenge");
    const user=await this.users.get(row.data.userId);
    if(!user?.data.active||user.data.tokenVersion!==row.data.tokenVersion) throw new HttpError(401,"Invalid session");
    return row;
  }
  private finishPending(row:Row) {return this.store.transact([{row:{...row,version:row.version+1,data:{...row.data,used:true}},expected:row.version}]);}
  async verifyMfa(id:unknown,code:unknown,ip:string,userAgent?:string) {
    await this.limit('mfa-ip:'+ip,20);
    const pending=await this.readPending(id,'totp');
    await this.limit('mfa-user:'+pending.data.userId,5);
    if(typeof code!=='string'||!/^\d{6}$/.test(code)) throw new HttpError(400,"Invalid code");
    const user=(await this.users.get(pending.data.userId))!;
    if(this.provider) {
      await this.provider.verifyTotp(user.data.id,this.vault.open(pending.data.sealed).providerSession,code);
      await this.finishPending(pending);
    } else {
      const row=await this.store.get('MFA',user.data.id);
      if(!row?.data.enabled) throw new HttpError(400,'MFA is not configured');
      const step=totpStep(this.vault.open(row.data.sealed).secret,code,row.data.lastStep,this.now());
      if(step===undefined) throw new HttpError(400,"Invalid or previously used code");
      await this.store.transact([
        {row:{...row,version:row.version+1,data:{...row.data,lastStep:step}},expected:row.version},
        {row:{...pending,version:pending.version+1,data:{...pending.data,used:true}},expected:pending.version}
      ]);
    }
    return this.session(user, { ip, userAgent });
  }
  async setupMfa(id:string,password:unknown,ip:string) {
    await this.limit('mfa-setup:'+ip,5);await this.limit('mfa-setup-user:'+id,5);
    if(!(await this.settings()).values.passwordLogin) throw new HttpError(409,"Enable password sign-in before enabling MFA");
    if(await this.hasMfa(id)) throw new HttpError(409,"MFA is already enabled");
    const user=await this.users.get(id);
    if(!user) throw new HttpError(404,"User not found");
    validatePassword(password);
    let secret:string, accessToken:string|undefined;
    if(this.provider) {
      const result=await this.provider.password(id,password);
      if('challenge' in result) throw new HttpError(409,"MFA is already enabled");
      accessToken=result.accessToken;secret=await this.provider.beginTotp(accessToken);
    } else {
      if(!await verifyPassword(password,user.data.passwordHash)) throw new HttpError(401,"Incorrect password");
      secret=totpSecret();
    }
    const pending=await this.pending(user,'enroll',{secret,accessToken});
    return {...pending,secret,uri:`otpauth://totp/RT-APP:${encodeURIComponent(user.data.email)}?secret=${secret}&issuer=RT-APP&algorithm=SHA1&digits=6&period=30`};
  }
  async enableMfa(id:string,challengeId:unknown,code:unknown,ip:string) {
    await this.limit('mfa-enable:'+ip,10);await this.limit('mfa-enable-user:'+id,5);
    const pending=await this.readPending(challengeId,'enroll');
    if(pending.data.userId!==id) throw new HttpError(403,"Challenge belongs to another account");
    if(await this.hasMfa(id)) throw new HttpError(409,"MFA is already enabled");
    if(typeof code!=='string'||!/^\d{6}$/.test(code))throw new HttpError(400,"Invalid code");
    const user=await this.users.get(id);
    if(!user) throw new HttpError(404,"User not found");
    const value=this.vault.open(pending.data.sealed);
    if(this.provider) {
      await this.provider.enableTotp(id,value.accessToken,code);
      // Invalidate all application sessions and retain an enrollment marker atomically.
      await this.store.transact([
        {row:{pk:'MFA',sk:id,version:1,data:{enabled:true,provider:this.provider.id}},expected:null},
        {row:{...pending,version:pending.version+1,data:{...pending.data,used:true}},expected:pending.version},
        {row:{...user,version:user.version+1,data:{...user.data,tokenVersion:user.data.tokenVersion+1}},expected:user.version}
      ]);
    } else {
      const step=totpStep(value.secret,code,-1,this.now());if(step===undefined)throw new HttpError(400,"Invalid code");
      await this.store.transact([
        {row:{pk:'MFA',sk:id,version:1,data:{enabled:true,sealed:this.vault.seal({secret:value.secret}),lastStep:step}},expected:null},
        {row:{...pending,version:pending.version+1,data:{...pending.data,used:true}},expected:pending.version},
        {row:{...user,version:user.version+1,data:{...user.data,tokenVersion:user.data.tokenVersion+1}},expected:user.version}
      ]);
    }
    return {message:"MFA enabled. Sign in again.",reauthenticate:true};
  }
  async resetMfa(id:unknown) {
    if(typeof id!=='string'||id.length>100)throw new HttpError(400,"Invalid user");
    const user=await this.users.get(id);if(!user)throw new HttpError(404,"User not found");
    const mfa=await this.store.get('MFA',id);
    if(this.provider) await this.provider.disableMfa(id);
    await this.store.transact([
      ...(mfa?[{row:mfa,expected:mfa.version,delete:true}]:[]),
      {row:{...user,version:user.version+1,data:{...user.data,tokenVersion:user.data.tokenVersion+1}},expected:user.version}
    ]);
    return {message:"MFA reset; application sessions have been invalidated."};
  }
  async settings() {
    const row = await this.store.get("SETTINGS", "auth");
    return {
      version: row?.version ?? 0,
      values: row?.data ?? { passwordLogin: true, emailCodeLogin: true },
      fields: [
        {
          name: "passwordLogin",
          label: "Allow password sign-in",
          type: "boolean",
        },
        {
          name: "emailCodeLogin",
          label: "Allow email code sign-in",
          type: "boolean",
        },
      ],
    };
  }
  /** Whether any account has MFA enabled, across every page of the MFA partition. */
  private async anyMfaEnabled() {
    let cursor: string | undefined;
    do {
      const page = await this.store.list('MFA', cursor);
      if (page.items.some(r => r.data.enabled)) return true;
      cursor = page.cursor;
    } while (cursor);
    return false;
  }
  async updateSettings(input: Record<string, any>) {
    const { version, values } = input;
    if (
      !Number.isInteger(version) ||
      typeof values?.passwordLogin !== "boolean" ||
      typeof values?.emailCodeLogin !== "boolean" ||
      (!values.passwordLogin && !values.emailCodeLogin)
    )
      throw new HttpError(
        400,
        "At least one sign-in method must remain enabled",
      );
    if (!values.passwordLogin && (await this.anyMfaEnabled()))
      throw new HttpError(409,"Password sign-in is required for accounts with MFA");
    const row = await this.store.get("SETTINGS", "auth");
    if (version !== (row?.version ?? 0)) throw new Conflict();
    await this.store.transact([
      {
        row: {
          pk: "SETTINGS",
          sk: "auth",
          version: version + 1,
          data: {
            passwordLogin: values.passwordLogin,
            emailCodeLogin: values.emailCodeLogin,
          },
        },
        expected: row?.version ?? null,
      },
    ]);
    return this.settings();
  }
  feature(): Feature {
    return {
      id: "auth",
      admin: {
        id: "auth",
        group: "authentication",
        title: "Authentication",
        resource: "auth.settings.read",
        path: "/auth/settings",
        component: "auth-settings",
        fields: [],
        actions: [],
        settings: { path: "/auth/settings", resource: "auth.settings.write" },
      },
      migrations,
      endpoints: [
        {method:'POST',path:'/auth/mfa/reset',resource:'auth.mfa.reset',access:'owner',handle:c=>this.resetMfa(c.request.body.userId)},
        {method:'POST',path:'/auth/mfa/verify',resource:'auth.mfa.verify',access:'guest',handle:c=>this.verifyMfa(c.request.body.challengeId,c.request.body.code,c.request.ip,userAgent(c.request))},
        {method:'GET',path:'/auth/mfa',resource:'auth.mfa.status',access:'authenticated',handle:async c=>({enabled:await this.hasMfa(c.actor!.id),type:'totp'})},
        {method:'POST',path:'/auth/mfa/setup',resource:'auth.mfa.setup',access:'authenticated',handle:c=>this.setupMfa(c.actor!.id,c.request.body.password,c.request.ip)},
        {method:'POST',path:'/auth/mfa/enable',resource:'auth.mfa.enable',access:'authenticated',handle:c=>this.enableMfa(c.actor!.id,c.request.body.challengeId,c.request.body.code,c.request.ip)},
        {
          method: "GET",
          path: "/auth/methods",
          resource: "auth.methods",
          access: "guest",
          handle: async () => ({...(await this.settings()).values, provider:this.provider?.id ?? "local",totp:true,selfRegistration:false,refreshTokens:true}),
        },
        {
          method: "GET",
          path: "/auth/settings",
          resource: "auth.settings.read",
          access: "permission",
          handle: () => this.settings(),
        },
        {
          method: "PUT",
          path: "/auth/settings",
          resource: "auth.settings.write",
          access: "owner",
          handle: (c) => this.updateSettings(c.request.body),
        },
        {
          method: "POST",
          path: "/auth/login",
          resource: "auth.login",
          access: "guest",
          handle: (c) =>
            this.login(
              emailAddress(c.request.body.email),
              c.request.body.password,
              c.request.ip,
              userAgent(c.request),
            ),
        },
        {
          method: "POST",
          path: "/auth/code",
          resource: "auth.code",
          access: "guest",
          handle: (c) =>
            this.issue(
              emailAddress(c.request.body.email),
              "login",
              c.request.ip,
            ),
        },
        {
          method: "POST",
          path: "/auth/code/verify",
          resource: "auth.code.verify",
          access: "guest",
          handle: (c) =>
            this.consume(
              emailAddress(c.request.body.email),
              c.request.body.code,
              "login",
              c.request.ip,
              undefined,
              c.request.body.challengeId,
              userAgent(c.request),
            ),
        },
        {
          method: "POST",
          path: "/auth/forgot-password",
          resource: "auth.forgot",
          access: "guest",
          handle: (c) =>
            this.issue(
              emailAddress(c.request.body.email),
              "reset",
              c.request.ip,
            ),
        },
        {
          method: "POST",
          path: "/auth/reset-password",
          resource: "auth.reset",
          access: "guest",
          handle: (c) =>
            this.consume(
              emailAddress(c.request.body.email),
              c.request.body.code,
              "reset",
              c.request.ip,
              c.request.body.password,
            ),
        },
        {
          method: "POST",
          path: "/auth/email-change",
          resource: "auth.email.change",
          access: "authenticated",
          handle: (c) =>
            this.requestEmailChange(
              c.actor!.id,
              emailAddress(c.request.body.email),
              c.request.ip,
            ),
        },
        {
          method: "POST",
          path: "/auth/email-change/verify",
          resource: "auth.email.verify",
          access: "authenticated",
          handle: (c) =>
            this.confirmEmailChange(
              c.actor!.id,
              c.request.body.code,
              c.request.ip,
              userAgent(c.request),
            ),
        },
        {
          method: "POST",
          path: "/auth/refresh",
          resource: "auth.refresh",
          access: "guest",
          handle: (c) => this.refresh(c.request.body.refreshToken, c.request.ip),
        },
        {
          method: "GET",
          path: "/auth/sessions",
          resource: "auth.sessions.list",
          access: "authenticated",
          handle: (c) => this.sessions(c.actor!.id, c.actor!.sessionId),
        },
        {
          method: "DELETE",
          path: "/auth/sessions/:id",
          resource: "auth.sessions.revoke",
          access: "authenticated",
          handle: (c) => this.revokeSession(c.actor!.id, c.params.id),
        },
        {
          method: "POST",
          path: "/auth/logout",
          resource: "auth.logout",
          access: "authenticated",
          handle: (c) => this.logout(c.actor!.id, c.actor!.sessionId, c.request.body.all),
        },
      ],
    };
  }
}
