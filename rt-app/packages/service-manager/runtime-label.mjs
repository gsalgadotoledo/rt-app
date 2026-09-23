import {basename} from 'node:path';
/** Identify declared application runtime, rather than an npm launcher alone. */
export function runtimeLabel(service, backend) {
 if(service.id==='api'&&['python','go','java','node-ts'].includes(backend))return {python:'Python',go:'Go',java:'Java','node-ts':'Node'}[backend];
 const executable=basename(service.command?.[0]??'').replace(/\.exe$/i,'');
 if(/^(node|nodejs|npm|npx|pnpm|yarn|bun|tsx|ts-node)$/.test(executable))return 'Node';
 if(/^(python(?:\d+(?:\.\d+)*)?|uv|uvicorn|gunicorn|poetry)$/.test(executable))return 'Python';
 if(executable==='go')return 'Go';
 if(['java','javac','mvn','gradle'].includes(executable))return 'Java';
 return null;
}
