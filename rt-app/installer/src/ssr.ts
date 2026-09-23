import {AmplifyClient,GetAppCommand,UpdateAppCommand,StartJobCommand,GetJobCommand} from '@aws-sdk/client-amplify';
import {setTimeout as delay} from 'node:timers/promises';
export async function publishSsr(options:{region:string;repository:string;appId:string;branch:string;revision?:string;token?:string;progress:(message:string)=>void;requireReady?:boolean}) {
  const client=new AmplifyClient({region:options.region});
  try {
    const repository=`https://github.com/${options.repository}`;
    const app=(await client.send(new GetAppCommand({appId:options.appId}))).app;
    if(app?.repository && app.repository.replace(/\.git$/,'')!==repository)throw new Error('Amplify is connected to a different repository');
    if(!app?.repository) {
      if(!options.token) {
        if(options.requireReady)throw new Error('Connect the Amplify GitHub App and provide AMPLIFY_GITHUB_TOKEN once during installation before CI deployment.');
        options.progress('SSR infrastructure created. Install the Amplify GitHub App for this repository, then rerun setup with AMPLIFY_GITHUB_TOKEN.');
        return {status:'awaiting_repository' as const};
      }
      await client.send(new UpdateAppCommand({appId:options.appId,repository,accessToken:options.token}));
    }
    const revision=options.revision && /^[a-f0-9]{40}$/.test(options.revision)?options.revision:undefined;
    const job=await client.send(new StartJobCommand({appId:options.appId,branchName:options.branch,jobType:'RELEASE',...(revision?{commitId:revision}:{})}));
    const jobId=job.jobSummary?.jobId;if(!jobId)throw new Error('Amplify did not return a build job');
    const deadline=Date.now()+30*60*1000;
    while(Date.now()<deadline) {
      const result=await client.send(new GetJobCommand({appId:options.appId,branchName:options.branch,jobId}));
      const summary=result.job?.summary;
      if(summary?.status==='SUCCEED') {
        if(revision && summary.commitId!==revision)throw new Error('Amplify published a different revision; inspect the build before releasing');
        return {status:'ready' as const,jobId,commitId:summary.commitId};
      }
      if(['FAILED','CANCELLED'].includes(summary?.status??''))throw new Error(`Amplify SSR build ${jobId} ${summary?.status}. Inspect the Amplify build logs.`);
      options.progress(`Amplify SSR build ${jobId}: ${summary?.status??'PENDING'}`);
      await delay(10000);
    }
    throw new Error(`Amplify SSR build ${jobId} is still pending; inspect its status in AWS before retrying.`);
  }finally{client.destroy();}
}
