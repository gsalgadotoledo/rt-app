export function visitPoint(type:string,event:any,path:string,elapsed:number,viewport:{width:number;height:number;scroll:number}):{type:string;path:string;t:number;x:number;y:number}|undefined;
export function startVisitCapture(options:{apiUrl:string;pages?:string[];enabled?:boolean;fetcher?:typeof fetch}):()=>void;
