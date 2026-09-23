import {
 CognitoIdentityProviderClient, AdminCreateUserCommand, AdminGetUserCommand,
 AdminSetUserPasswordCommand, InitiateAuthCommand, RespondToAuthChallengeCommand,
 GetUserCommand, ForgotPasswordCommand, ConfirmForgotPasswordCommand,
 AssociateSoftwareTokenCommand, VerifySoftwareTokenCommand, AdminSetUserMFAPreferenceCommand,
 AdminUserGlobalSignOutCommand, AdminUpdateUserAttributesCommand, AdminDisableUserCommand, AdminEnableUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type {IdentityProvider} from '@gsalgadotoledo/rt-app-auth';
import {HttpError} from '@gsalgadotoledo/rt-app-contracts';
export class CognitoIdentity implements IdentityProvider {
 readonly id='cognito';
 private client:CognitoIdentityProviderClient;
 constructor(private poolId:string,private clientId:string,region:string,client?:CognitoIdentityProviderClient){
   if(!poolId||!clientId||!region)throw new Error('COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID and AWS_REGION are required');
   this.client=client??new CognitoIdentityProviderClient({region});
 }
 private async send(command:any):Promise<any>{
   try{return await this.client.send(command);}
   catch(e:any){
     if(['TooManyRequestsException','LimitExceededException'].includes(e.name))throw new HttpError(429,"Too many attempts; try again later");
     if(['NotAuthorizedException','UserNotFoundException','CodeMismatchException','ExpiredCodeException','SoftwareTokenMFANotFoundException'].includes(e.name))throw new HttpError(401,"Invalid credentials or code");
     if(['InvalidPasswordException','PasswordHistoryPolicyViolationException'].includes(e.name))throw new HttpError(400,"The password does not meet the provider's policy");
     if(e.name==='InvalidParameterException')throw new HttpError(400,"Operation unavailable for this account");
     throw e;
   }
 }
 async provision(id:string,email:string,password:string){
   try {await this.client.send(new AdminCreateUserCommand({UserPoolId:this.poolId,Username:id,MessageAction:'SUPPRESS',UserAttributes:[{Name:'email',Value:email},{Name:'email_verified',Value:'true'}]}));}
   catch(e:any){if(e.name!=='UsernameExistsException')throw e;
     const existing=await this.send(new AdminGetUserCommand({UserPoolId:this.poolId,Username:id}));
     if(existing.UserAttributes?.find((a:any)=>a.Name==='email')?.Value!==email)throw new Error('Cognito identity mismatch');
   }
   await this.send(new AdminSetUserPasswordCommand({UserPoolId:this.poolId,Username:id,Password:password,Permanent:true}));
 }
 private async authenticated(id:string,result:any):Promise<{accessToken:string}>{
   const accessToken=result.AuthenticationResult?.AccessToken;
   if(!accessToken)throw new HttpError(401,"Authentication incomplete");
   // GetUser validates the token with Cognito. Never decode unverified JWT claims.
   const user=await this.send(new GetUserCommand({AccessToken:accessToken}));
   if(user.Username!==id)throw new HttpError(401,"Identity mismatch");
   return {accessToken};
 }
 async password(id:string,password:string){
   const result=await this.send(new InitiateAuthCommand({ClientId:this.clientId,AuthFlow:'USER_PASSWORD_AUTH',AuthParameters:{USERNAME:id,PASSWORD:password}}));
   if(result.ChallengeName==='SOFTWARE_TOKEN_MFA'&&result.Session)return {challenge:'totp' as const,session:result.Session};
   if(result.ChallengeName)throw new HttpError(409,"This account requires a Cognito flow that is not enabled in this starter");
   return this.authenticated(id,result);
 }
 async emailCode(id:string){
   const r=await this.send(new InitiateAuthCommand({ClientId:this.clientId,AuthFlow:'USER_AUTH',AuthParameters:{USERNAME:id,PREFERRED_CHALLENGE:'EMAIL_OTP'}}));
   if(r.ChallengeName!=='EMAIL_OTP'||!r.Session)throw new HttpError(409,"Use a password and authenticator for this account");
   return r.Session as string;
 }
 async verifyEmailCode(id:string,session:string,code:string){return this.respond(id,session,'EMAIL_OTP','EMAIL_OTP_CODE',code);}
 async verifyTotp(id:string,session:string,code:string){return this.respond(id,session,'SOFTWARE_TOKEN_MFA','SOFTWARE_TOKEN_MFA_CODE',code);}
 private async respond(id:string,session:string,challenge:'EMAIL_OTP'|'SOFTWARE_TOKEN_MFA',field:string,code:string){
   const r=await this.send(new RespondToAuthChallengeCommand({ClientId:this.clientId,ChallengeName:challenge,Session:session,ChallengeResponses:{USERNAME:id,[field]:code}}));
   return this.authenticated(id,r);
 }
 async forgot(id:string){await this.send(new ForgotPasswordCommand({ClientId:this.clientId,Username:id}));}
 async reset(id:string,code:string,password:string){await this.send(new ConfirmForgotPasswordCommand({ClientId:this.clientId,Username:id,ConfirmationCode:code,Password:password}));}
 async mfaStatus(id:string){const r=await this.send(new AdminGetUserCommand({UserPoolId:this.poolId,Username:id}));return !!r.UserMFASettingList?.includes('SOFTWARE_TOKEN_MFA');}
 async beginTotp(accessToken:string){const r=await this.send(new AssociateSoftwareTokenCommand({AccessToken:accessToken}));if(!r.SecretCode)throw new Error('Missing TOTP secret');return r.SecretCode as string;}
 async enableTotp(id:string,accessToken:string,code:string){
   const user=await this.send(new GetUserCommand({AccessToken:accessToken}));if(user.Username!==id)throw new HttpError(401,"Identity mismatch");
   const r=await this.send(new VerifySoftwareTokenCommand({AccessToken:accessToken,UserCode:code}));
   if(r.Status!=='SUCCESS')throw new HttpError(400,"Invalid code");
   await this.send(new AdminSetUserMFAPreferenceCommand({UserPoolId:this.poolId,Username:id,SoftwareTokenMfaSettings:{Enabled:true,PreferredMfa:true}}));
 }
 async enable(id:string){await this.send(new AdminEnableUserCommand({UserPoolId:this.poolId,Username:id}));}
 async disable(id:string){await this.send(new AdminDisableUserCommand({UserPoolId:this.poolId,Username:id}));}
 async disableMfa(id:string){await this.send(new AdminSetUserMFAPreferenceCommand({UserPoolId:this.poolId,Username:id,SoftwareTokenMfaSettings:{Enabled:false,PreferredMfa:false}}));}
 async logout(id:string){await this.send(new AdminUserGlobalSignOutCommand({UserPoolId:this.poolId,Username:id}));}
 async changeEmail(id:string,email:string){await this.send(new AdminUpdateUserAttributesCommand({UserPoolId:this.poolId,Username:id,UserAttributes:[{Name:'email',Value:email},{Name:'email_verified',Value:'true'}]}));}
}
