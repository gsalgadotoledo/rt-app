import {randomUUID} from 'node:crypto';
import {STSClient,GetCallerIdentityCommand} from '@aws-sdk/client-sts';
import {LambdaClient,GetFunctionConcurrencyCommand,PutFunctionConcurrencyCommand,DeleteFunctionConcurrencyCommand,ListTagsCommand} from '@aws-sdk/client-lambda';
import {EC2Client,DescribeInstancesCommand,StopInstancesCommand,StartInstancesCommand} from '@aws-sdk/client-ec2';
import {RDSClient,DescribeDBInstancesCommand,ListTagsForResourceCommand,StopDBInstanceCommand,StartDBInstanceCommand} from '@aws-sdk/client-rds';
import {HttpError,type Store} from '@gsalgadotoledo/rt-app-contracts';
export class AwsBrake {
 constructor(private store:Store,private application=process.env.RT_APP_AWS_APP){}
 private config(region:string){return {region,maxAttempts:1,requestHandler:{connectionTimeout:2000,requestTimeout:8000}};}
 private async inspect(arn:string){
  if(!this.application||!/^rt-app-[a-z0-9-]{3,30}$/.test(this.application))throw new HttpError(403,'Set RT_APP_AWS_APP to enable the scoped emergency brake');
  const match=/^arn:aws:(lambda|ec2|rds):([a-z0-9-]+):(\d{12}):(.+)$/.exec(arn);if(!match)throw new HttpError(400,'Only Lambda functions, EC2 instances and RDS DB instances can be paused');
  const [,service,region,account,resource]=match;const sts=new STSClient(this.config(region));try{const identity=await sts.send(new GetCallerIdentityCommand({}));if(identity.Account!==account||identity.Arn?.endsWith(':root'))throw new HttpError(403,'Use a non-root identity in the same AWS account');}finally{sts.destroy();}
  let tags:Record<string,string|undefined>={},state:any,client:any;
  try{
   if(service==='lambda'){
    if(!/^function:[a-zA-Z0-9_-]+$/.test(resource))throw new HttpError(400,'Select an unqualified function ARN');const name=resource.slice(9);
    if(name===process.env.AWS_LAMBDA_FUNCTION_NAME)throw new HttpError(409,'This function hosts the admin. Pause it from the local admin so you can resume it later');
    client=new LambdaClient(this.config(region));tags=(await client.send(new ListTagsCommand({Resource:arn}))).Tags??{};
    state={concurrency:(await client.send(new GetFunctionConcurrencyCommand({FunctionName:arn}))).ReservedConcurrentExecutions??null};
   }else if(service==='ec2'){
    if(!/^instance\/i-[a-f0-9]+$/.test(resource))throw new HttpError(400,'Select an EC2 instance');client=new EC2Client(this.config(region));const result=await client.send(new DescribeInstancesCommand({InstanceIds:[resource.slice(9)]}));const item=result.Reservations?.[0]?.Instances?.[0];if(!item)throw new HttpError(404,'Instance not found');tags=Object.fromEntries((item.Tags??[]).map((t:any)=>[t.Key,t.Value]));state={status:item.State?.Name};
   }else{
    if(!/^db:[a-zA-Z0-9-]+$/.test(resource))throw new HttpError(400,'Select an RDS DB instance');client=new RDSClient(this.config(region));const item=(await client.send(new DescribeDBInstancesCommand({DBInstanceIdentifier:resource.slice(3)}))).DBInstances?.[0];if(!item||item.DBClusterIdentifier)throw new HttpError(400,'Cluster-managed databases are not supported');tags=Object.fromEntries(((await client.send(new ListTagsForResourceCommand({ResourceName:arn}))).TagList??[]).map((t:any)=>[t.Key,t.Value]));state={status:item.DBInstanceStatus};
   }
   if(tags.Application!==this.application)throw new HttpError(403,'Resource is outside this application tag scope');
   return {arn,service,region,resource,state};
  }finally{client?.destroy();}
 }
 async plan(arn:string,action:string,actor:string){
  if(!['pause','resume'].includes(action)||typeof arn!=='string'||arn.length>512)throw new HttpError(400,'Invalid brake request');
  const target=await this.inspect(arn),previous=await this.store.get('AWS_BRAKE',arn);
  if(previous?.data.phase==='applying'||previous?.data.phase==='uncertain')throw new HttpError(409,'A previous operation needs AWS verification before another action');
  if(action==='resume'&&previous?.data.phase!=='paused')throw new HttpError(409,'No recorded pause to restore');
  if(action==='pause'&&(previous?.data.phase==='paused'||(target.service==='lambda'?target.state.concurrency===0:!['running','available'].includes(target.state.status))))throw new HttpError(409,'Resource is already paused or transitioning');
  if(action==='resume'&&(target.service==='lambda'?target.state.concurrency!==0:target.state.status!=='stopped'))throw new HttpError(409,'Resource is not in the recorded stopped state');
  const id=randomUUID(),expires=Date.now()+300000;
  const warning=target.service==='lambda'?'Blocks new invocations; active invocations, API Gateway, queues, retries and storage can still cost money. Async events can be discarded or retried.':target.service==='rds'?'Stops compute when AWS finishes the transition. Storage and backups still cost money. RDS restarts automatically after 7 days.':'Stops the instance when AWS finishes the transition. EBS, snapshots and other resources can still cost money.';
  const data={...target,action,actor,expires,phase:'planned',previousVersion:previous?.version??null,original:action==='pause'?target.state:previous!.data.original};
  await this.store.transact([{row:{pk:'AWS_BRAKE_PLAN',sk:id,version:1,data},expected:null}]);
  return {id,arn,action,expires,warning,confirmation:arn};
 }
 async execute(id:string,confirmation:string,actor:string){
  const row=await this.store.get('AWS_BRAKE_PLAN',id);if(!row||row.data.actor!==actor||row.data.expires<Date.now()||row.data.phase!=='planned'||confirmation!==row.data.arn)throw new HttpError(409,'Invalid, expired or already used confirmation');
  const p=row.data,target=await this.inspect(p.arn);if(JSON.stringify(target.state)!==JSON.stringify(p.state))throw new HttpError(409,'AWS state changed. Create a new plan');
  const state={pk:'AWS_BRAKE',sk:p.arn,version:(p.previousVersion??0)+1,data:{...p,phase:'applying'}};
  await this.store.transact([{row:{...row,version:row.version+1,data:{...p,phase:'applying'}},expected:row.version},{row:state,expected:p.previousVersion}]);
  let client:any;
  try{
   if(p.service==='lambda'){client=new LambdaClient(this.config(p.region));await client.send(p.action==='pause'?new PutFunctionConcurrencyCommand({FunctionName:p.arn,ReservedConcurrentExecutions:0}):p.original.concurrency===null?new DeleteFunctionConcurrencyCommand({FunctionName:p.arn}):new PutFunctionConcurrencyCommand({FunctionName:p.arn,ReservedConcurrentExecutions:p.original.concurrency}));}
   else if(p.service==='ec2'){client=new EC2Client(this.config(p.region));await client.send(p.action==='pause'?new StopInstancesCommand({InstanceIds:[p.resource.slice(9)]}):new StartInstancesCommand({InstanceIds:[p.resource.slice(9)]}));}
   else{client=new RDSClient(this.config(p.region));await client.send(p.action==='pause'?new StopDBInstanceCommand({DBInstanceIdentifier:p.resource.slice(3)}):new StartDBInstanceCommand({DBInstanceIdentifier:p.resource.slice(3)}));}
   await this.store.transact([{row:{...state,version:state.version+1,data:{...p,phase:p.action==='pause'?'paused':'resumed',updatedAt:new Date().toISOString()}},expected:state.version}]);return {accepted:true,action:p.action,arn:p.arn,message:'AWS accepted the request. Refresh the resource status; other charges can continue.'};
  }catch{await this.store.transact([{row:{...state,version:state.version+1,data:{...p,phase:'uncertain'}},expected:state.version}]).catch(()=>{});throw new HttpError(502,'Operation outcome is uncertain. Check AWS before retrying; no resources were deleted');}finally{client?.destroy();}
 }
}
