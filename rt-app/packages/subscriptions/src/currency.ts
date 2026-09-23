// ISO currency codes from the runtime's CLDR catalog; Stripe availability varies by account.
export const currencyCodes = ["aed","afn","all","amd","ang","aoa","ars","aud","awg","azn","bam","bbd","bdt","bgn","bhd","bif","bmd","bnd","bob","brl","bsd","btn","bwp","byn","bzd","cad","cdf","chf","clp","cny","cop","crc","cuc","cup","cve","czk","djf","dkk","dop","dzd","egp","ern","etb","eur","fjd","fkp","gbp","gel","ghs","gip","gmd","gnf","gtq","gyd","hkd","hnl","hrk","htg","huf","idr","ils","inr","iqd","irr","isk","jmd","jod","jpy","kes","kgs","khr","kmf","kpw","krw","kwd","kyd","kzt","lak","lbp","lkr","lrd","lsl","lyd","mad","mdl","mga","mkd","mmk","mnt","mop","mru","mur","mvr","mwk","mxn","myr","mzn","nad","ngn","nio","nok","npr","nzd","omr","pab","pen","pgk","php","pkr","pln","pyg","qar","ron","rsd","rub","rwf","sar","sbd","scr","sdg","sek","sgd","shp","sle","sll","sos","srd","ssp","stn","svc","syp","szl","thb","tjs","tmt","tnd","top","try","ttd","twd","tzs","uah","ugx","usd","uyu","uzs","ves","vnd","vuv","wst","xaf","xcd","xcg","xdr","xof","xpf","xsu","yer","zar","zmw","zwg","zwl"] as const;
export function validCurrency(code: unknown): code is string {return typeof code === 'string' && (currencyCodes as readonly string[]).includes(code);}
export function currencyDecimals(code: string): number {
  if (['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','vnd','vuv','xaf','xof','xpf'].includes(code.toLowerCase())) return 0;
  if (['isk','ugx'].includes(code.toLowerCase())) return 2; // Stripe's backwards-compatible charge units
  return ['bhd','iqd','jod','kwd','lyd','omr','tnd'].includes(code.toLowerCase()) ? 3 : 2;
}
export function majorAmount(minor: number, code: string) {return minor / 10 ** currencyDecimals(code);}
export function formatMoney(minor: number, code: string) {return new Intl.NumberFormat('en',{style:'currency',currency:code,currencyDisplay:'code',minimumFractionDigits:currencyDecimals(code),maximumFractionDigits:currencyDecimals(code)}).format(majorAmount(minor,code));}
export function currencyStep(code: string) {return ['isk','ugx'].includes(code.toLowerCase()) ? 1 : 1 / 10 ** currencyDecimals(code);}
export function validMinorAmount(amount: number, code: string) {return Number.isSafeInteger(amount) && amount >= 0 && (!['isk','ugx'].includes(code.toLowerCase()) || amount % 100 === 0);}
