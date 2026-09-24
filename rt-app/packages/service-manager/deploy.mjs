import {loadRegistry,readDeploySettings,credentialStatus,githubRepository,connectGithub,BRANCHES} from '@gsalgadotoledo/rt-app-deployments';
import {ROLES,ROLE_LABELS,ENVIRONMENTS} from '@gsalgadotoledo/rt-app-deploy';

/**
 * Deploy overview of the selected project for the Service Manager: providers per role, targets
 * per environment, which API keys are present (never values) and the GitHub repository.
 */
export async function deployInfo(root,{run,registry}={}){
 registry??=await loadRegistry();
 const {deploy}=await readDeploySettings(root,registry);
 return {
  providers:registry.catalog(),
  roles:ROLES.map(id=>({id,label:ROLE_LABELS[id]})),
  environments:ENVIRONMENTS.map(id=>({id,branch:BRANCHES[id],targets:deploy.environments[id]??{}})),
  credentials:await credentialStatus(root,registry,deploy),
  repository:githubRepository(root,run)??null,
 };
}

/** Create the GitHub repository for the project (private) and push it; reuses an existing origin. */
export function connectProject(root,{run}={}){return connectGithub(root,{run,visibility:'private'});}
