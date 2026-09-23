import type { CredentialProvider } from '@gsalgadotoledo/rt-app-users';
export type IdentityResult = {accessToken:string} | {challenge:'totp'; session:string};
/** Provider credentials never become application permissions or admin identities. */
export interface IdentityProvider extends CredentialProvider {
  password(id:string,password:string):Promise<IdentityResult>;
  emailCode(id:string):Promise<string>;
  verifyEmailCode(id:string,session:string,code:string):Promise<{accessToken:string}>;
  forgot(id:string):Promise<void>;
  reset(id:string,code:string,password:string):Promise<void>;
  verifyTotp(id:string,session:string,code:string):Promise<{accessToken:string}>;
  mfaStatus(id:string):Promise<boolean>;
  beginTotp(accessToken:string):Promise<string>;
  enableTotp(id:string,accessToken:string,code:string):Promise<void>;
  logout(id:string):Promise<void>;
  disableMfa(id:string):Promise<void>;
  changeEmail(id:string,email:string):Promise<void>;
}
