export interface BrowserViewOptions {url:string;apiUrl:string;source?:'spa'|'ssr';pages?:string[]}
export function countView(message:string,options:BrowserViewOptions):Promise<boolean>;
export function trackPage(api:string,source:'spa'|'ssr',pathname:string,pages?:string[]):void;
