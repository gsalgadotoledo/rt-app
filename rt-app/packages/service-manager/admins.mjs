/**
 * Web admins for shared services. Some services include their own UI (Mailpit, the JSON server);
 * databases need a separate admin tool that the catalog can install. `adminFor` tells the UI what
 * "View admin" does for a service: open a URL, install a tool first, or explain that none exists yet.
 */

export const ADMIN_TOOLS={
 postgres:{tool:'pgweb',name:'pgweb',description:'Web-based PostgreSQL browser (single binary, official release).'},
 redis:{tool:null,name:null,description:'No web admin is bundled yet. Use redis-cli from the tools folder, or install RedisInsight.'},
 mongodb:{tool:null,name:null,description:'No web admin is bundled yet. MongoDB Compass works with the local port.'},
 sqlite:{tool:null,name:null,description:'Embedded database; open the file with the sqlite3 CLI or DB Browser for SQLite.'},
};

/**
 * What "View admin" means for a service id.
 * @returns {{kind:'url',url:string}|{kind:'install',tool:string,name:string,description:string}|{kind:'none',description:string}}
 */
export function adminFor(service,{installed=[],running={}}={}){
 const base=service.catalogId??service.id;
 // Services that serve their own UI (Mailpit, JSON server) open it directly.
 if(service.url&&!ADMIN_TOOLS[base])return {kind:'url',url:service.url};
 const admin=ADMIN_TOOLS[base];
 if(!admin)return {kind:'none',description:'This service has no web admin.'};
 if(!admin.tool)return {kind:'none',description:admin.description};
 if(running[admin.tool])return {kind:'url',url:running[admin.tool]};
 if(installed.includes(admin.tool))return {kind:'start',tool:admin.tool,name:admin.name};
 return {kind:'install',tool:admin.tool,name:admin.name,description:admin.description};
}
