export type Environment = 'local' | 'develop' | 'stage' | 'prod';
export interface PublicConfig { readonly environment: Environment; readonly urls: Readonly<Record<'api'|'admin'|'spa'|'ssr',string>>; }
export const localUrls: PublicConfig['urls'];
export function publicConfig(env?: Record<string,string|undefined>): PublicConfig;
export function environmentVariables(config:PublicConfig):Record<string,string>;
export function browserApiUrl(config:PublicConfig):string;
export function viteConfiguration(env?: Record<string,string|undefined>,role?: 'spa'|'admin'): {define:Record<string,string>;server:{host:string;port:number;strictPort:boolean;proxy:Record<string,{target:string;rewrite:(path:string)=>string}>}};
export function runtimeConfig(settings: {runtime:Record<string,{mode:string}>},env?:Record<string,string|undefined>):{target:'local'|'aws'|'portable';mode:'json'|'memory'|'dynamodb-local'|'postgres'|'aws'|'portable'};
