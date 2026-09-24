import { packageFile } from '@gsalgadotoledo/rt-app-config/paths';
import {readFile} from "node:fs/promises";
import {environmentVariables,publicConfig} from '@gsalgadotoledo/rt-app-config';
import {publishSsr} from './ssr.js';
import { passwordVerifier, validateVerifier } from "@gsalgadotoledo/rt-app-myadmin/backend";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  IAMClient,
  GetOpenIDConnectProviderCommand,
} from "@aws-sdk/client-iam";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { createProductionApplication } from "@gsalgadotoledo/rt-app-framework";
export interface InstallationConfig {
  multiEnvironment?: boolean;
  provider: "aws";
  region: string;
  stack: string;
  mailFrom: string;
  repository: string;
}
export interface InstallInput {
  config: InstallationConfig;
  modules: string[];
  expectedAccount: string;
  confirmation: string;
}
export const coreModules = ["content", "infra", "users", "auth", "acl"];
export function validateModules(modules: string[], additional: string[] = []) {
  if (
    !Array.isArray(modules) ||
    coreModules.some((id) => !modules.includes(id)) ||
    modules.some((id) => ![...coreModules, "tasks", ...additional].includes(id)) ||
    new Set(modules).size !== modules.length
  )
    throw new Error("Invalid modules");
  return modules;
}
export function validateInstallation(c: InstallationConfig) {
  if (
    (c.multiEnvironment !== undefined && typeof c.multiEnvironment !== "boolean") ||
    c.provider !== "aws" ||
    !/^rt-app-[a-z0-9-]{3,30}$/.test(c.stack) ||
    !/^[a-z]{2}(-[a-z]+)+-\d$/.test(c.region) ||
    !/^[-\w.]+\/[-\w.]+$/.test(c.repository) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.mailFrom)
  )
    throw new Error(
      "Provide an rt-app- name, region, SES sender and OWNER/REPO repository",
    );
  return c;
}
export async function inspectInstallation(config: InstallationConfig) {
  validateInstallation(config);
  const client = new STSClient({
    region: config.region,
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
  });
  try {
    const r = await client.send(new GetCallerIdentityCommand({}));
    if (!r.Account || !r.Arn || r.Arn.endsWith(":root"))
      throw new Error("Use a restricted IAM role or user, not root");
    return {
      account: r.Account,
      arn: r.Arn,
      resources: [
        "Terraform state S3 + GitHub OIDC",
        (cEnvironmentNames(config).join(", ") + ": Lambda + API Gateway"),
        "Cognito Essentials: users, passwords, email and TOTP; DynamoDB for profiles and data; separate admin identity",
        "Private S3 + CloudFront: admin and public React SPA",
        "Amplify Hosting: Next.js SSR (requires GitHub repository access)",
        "Admin protected by the ADMIN_PASSWORD environment variable",
      ],
    };
  } finally {
    client.destroy();
  }
}
export interface InstallHost {
  applicationModules?(): Promise<string[]>;
  migrateApplication?(modules?: string[]): Promise<void>;
  run(
    command: "npm" | "terraform",
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<string | void>;
  bindInstallation(identity: {
    account: string;
    app: string;
    region: string;
    repository: string;
    multiEnvironment?: boolean;
  }): Promise<{ managesOidc: boolean }>;
  configureModules(modules: string[]): Promise<void>;
  assets(
    site?: "admin" | "public",
  ): Promise<{ path: string; body: Uint8Array; type: string }[]>;
  save(result: object): Promise<void>;
  progress(message: string): void;
}
export async function publishEnvironment(
  config: InstallationConfig,
  environment: "develop" | "stage" | "prod",
  outputs: Record<string, string>,
  host: InstallHost,
  env: NodeJS.ProcessEnv,
  adminPassword?: string,
  modules?: string[],
) {
  for (const key of [
    "CognitoUserPoolId",
    "CognitoClientId",
    "TableName",
    "AdminPasswordSecretArn",
    "JwtSecretArn",
    "AwsCredentialsSecretArn",
    "ApiUrl",
    "AdminUrl",
    "PublicUrl",
    "AdminBucketName",
    "PublicBucketName",
    "AdminDistributionId",
    "PublicDistributionId",
  ])
    if (!outputs[key]) throw new Error("Missing output: " + key);
  const secrets = new SecretsManagerClient({ region: config.region });
  let secret: string | undefined;
  try {
    try {
      secret = (
        await secrets.send(
          new GetSecretValueCommand({ SecretId: outputs.JwtSecretArn }),
        )
      ).SecretString;
    } catch (e: any) {
      if (e.name !== "ResourceNotFoundException") throw e;
    }
    if (!secret) {
      secret = randomBytes(48).toString("hex");
      await secrets.send(
        new PutSecretValueCommand({
          SecretId: outputs.JwtSecretArn,
          SecretString: secret,
        }),
      );
    }
  } finally {
    secrets.destroy();
  }
  const adminSecrets = new SecretsManagerClient({ region: config.region });
  let verifier: string | undefined;
  try {
    if (adminPassword) {
      verifier = await passwordVerifier(adminPassword);
      await adminSecrets.send(
        new PutSecretValueCommand({
          SecretId: outputs.AdminPasswordSecretArn,
          SecretString: verifier,
        }),
      );
    } else {
      verifier = (
        await adminSecrets.send(
          new GetSecretValueCommand({
            SecretId: outputs.AdminPasswordSecretArn,
          }),
        )
      ).SecretString;
    }
    validateVerifier(verifier ?? "");
  } finally {
    adminSecrets.destroy();
  }
  Object.assign(process.env, env, {
    AUTH_PROVIDER: "cognito",
    COGNITO_USER_POOL_ID: outputs.CognitoUserPoolId,
    COGNITO_CLIENT_ID: outputs.CognitoClientId,
    TABLE_NAME: outputs.TableName,
    ADMIN_PASSWORD_VERIFIER: verifier,
    JWT_SECRET: secret,
    MAIL_FROM: config.mailFrom,
    AWS_CREDENTIALS_SECRET_ARN: outputs.AwsCredentialsSecretArn,
    NOSQL_PROVIDER: "dynamodb",
    INFRA_PROVIDER: "aws",
  });
  if (host.migrateApplication) await host.migrateApplication(modules);
  else await createProductionApplication(modules).migrate();
  delete process.env.JWT_SECRET;
  delete process.env.ADMIN_PASSWORD_VERIFIER;
  const shared = environmentVariables(publicConfig({
    RT_APP_ENVIRONMENT: environment,
    RT_APP_API_URL: outputs.ApiUrl,
    RT_APP_ADMIN_URL: outputs.AdminUrl,
    RT_APP_SPA_URL: outputs.PublicUrl,
    RT_APP_SSR_URL: outputs.SsrUrl || outputs.PublicUrl,
  }));
  const revision = env.TF_VAR_revision ?? "local";
  const s3 = new S3Client({ region: config.region }),
    cdn = new CloudFrontClient({ region: config.region });
  try {
    for (const site of ["admin", "public"] as const) {
      host.progress(environment + ": publishing " + site);
      await host.run("npm", ["run", site === "admin" ? "build:ui" : "build", "-w", site === "admin" ? "@gsalgadotoledo/rt-app-myadmin" : "@gsalgadotoledo/rt-app-spa"], {
        ...env,
        ...shared,
        VITE_RELEASE: environment + "-" + revision,
      });
      const bucket =
        outputs[site === "admin" ? "AdminBucketName" : "PublicBucketName"];
      const assets = (await host.assets(site)).sort(
        (a, b) =>
          Number(a.path === "index.html") - Number(b.path === "index.html"),
      );
      for (const asset of assets) {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: "releases/" + revision + "/" + asset.path,
            Body: asset.body,
            ContentType: asset.type,
          }),
        );
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: asset.path,
            Body: asset.body,
            ContentType: asset.type,
            CacheControl:
              asset.path === "index.html"
                ? "no-cache"
                : "public,max-age=31536000,immutable",
          }),
        );
      }
      await cdn.send(
        new CreateInvalidationCommand({
          DistributionId:
            outputs[
              site === "admin" ? "AdminDistributionId" : "PublicDistributionId"
            ],
          InvalidationBatch: {
            CallerReference: crypto.randomUUID(),
            Paths: { Quantity: 1, Items: ["/*"] },
          },
        }),
      );
    }
  } finally {
    s3.destroy();
    cdn.destroy();
  }
  const ssr = outputs.SsrAppId ? await publishSsr({
    region:config.region,repository:config.repository,appId:outputs.SsrAppId,
    branch:outputs.SsrBranch,revision:env.TF_VAR_revision,
    token:env.AMPLIFY_GITHUB_TOKEN,progress:message=>host.progress(environment+': '+message),
    requireReady:env.GITHUB_ACTIONS==='true',
  }) : undefined;
  return {
    ...(ssr?{ssr,ssrUrl:outputs.SsrUrl,ssrAppId:outputs.SsrAppId,ssrBranch:outputs.SsrBranch}:{}),
    environment,
    adminUrl: outputs.AdminUrl,
    publicUrl: outputs.PublicUrl,
    apiUrl: outputs.ApiUrl,
    revision,
    lambdaVersion: outputs.LambdaVersion,
  };
}
export async function install(input: InstallInput, host: InstallHost) {
  const c = validateInstallation(input.config);
  validateModules(input.modules, await host.applicationModules?.() ?? []);
  if (input.confirmation !== c.stack)
    throw new Error("Confirm the installation name");
  const rootPassword = process.env.ADMIN_PASSWORD;
  if (!rootPassword) throw new Error("Set ADMIN_PASSWORD before installation");
  await passwordVerifier(rootPassword);
  const identity = await inspectInstallation(c);
  if (identity.account !== input.expectedAccount)
    throw new Error("The account has changed");
  const binding = await host.bindInstallation({
    account: identity.account,
    app: c.stack,
    region: c.region,
    repository: c.repository,
    multiEnvironment: c.multiEnvironment ?? false,
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_REGION: c.region,
    TF_IN_AUTOMATION: "1",
    TF_VAR_multi_environment: String(c.multiEnvironment ?? false),
    TF_VAR_region: c.region,
    TF_VAR_app: c.stack,
    TF_VAR_mail_from: c.mailFrom,
    TF_VAR_repository: c.repository,
    TF_VAR_revision: Date.now().toString(),
  };
  delete env.ADMIN_PASSWORD;
  delete env.ADMIN_PASSWORD_VERIFIER;
  // This code executes in a dedicated installer worker, never in a request handler.
  Object.assign(process.env, env);
  const iam = new IAMClient({ region: c.region });
  try {
    const arn =
      "arn:aws:iam::" +
      identity.account +
      ":oidc-provider/token.actions.githubusercontent.com";
    try {
      if (binding.managesOidc) {
        env.TF_VAR_oidc_provider_arn = "";
      } else {
        await iam.send(
          new GetOpenIDConnectProviderCommand({
            OpenIDConnectProviderArn: arn,
          }),
        );
        env.TF_VAR_oidc_provider_arn = arn;
      }
    } catch (e: any) {
      if (e.name !== "NoSuchEntityException" && e.name !== "NoSuchEntity")
        throw e;
      env.TF_VAR_oidc_provider_arn = "";
    }
  } finally {
    iam.destroy();
  }
  await host.configureModules(input.modules);
  await host.run("npm", ["run", "lambda:build"], env);
  host.progress("Preparing remote state and GitHub OIDC roles");
  const state = resolve(".rt-app/bootstrap.tfstate"),
    plan = resolve(".rt-app/bootstrap.plan");
  let accessSettings:Record<string,any>={};
  try{accessSettings=JSON.parse(await readFile(resolve('.rt-app/aws-access.tfvars.json'),'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  if(Object.keys(accessSettings).length&&(accessSettings.app!==c.stack||accessSettings.repository!==c.repository||accessSettings.region!==c.region))throw new Error('AWS access configuration belongs to a different application. Review .rt-app/aws-access.tfvars.json');
  const bootstrapEnv = {
    ...env,
    TF_DATA_DIR: resolve(".rt-app/terraform-bootstrap"),
    ...Object.fromEntries(["operator_principal_arn","gitlab_project","gitlab_oidc_provider_arn"].filter(key=>accessSettings[key]).map(key=>["TF_VAR_"+key,String(accessSettings[key])])),
  };
  await host.run(
    "terraform",
    ['-chdir='+packageFile('@gsalgadotoledo/rt-app-infra','terraform/aws/bootstrap'), "init", "-input=false"],
    bootstrapEnv,
  );
  await host.run(
    "terraform",
    [
      '-chdir='+packageFile('@gsalgadotoledo/rt-app-infra','terraform/aws/bootstrap'),
      "plan",
      "-input=false",
      "-state=" + state,
      "-out=" + plan,
    ],
    bootstrapEnv,
  );
  await host.run(
    "terraform",
    ['-chdir='+packageFile('@gsalgadotoledo/rt-app-infra','terraform/aws/bootstrap'), "apply", "-input=false", plan],
    bootstrapEnv,
  );
  const bootstrap = JSON.parse(
    String(
      await host.run(
        "terraform",
        [
          '-chdir='+packageFile('@gsalgadotoledo/rt-app-infra','terraform/aws/bootstrap'),
          "output",
          "-state=" + state,
          "-json",
          "bootstrap",
        ],
        bootstrapEnv,
      ),
    ),
  );
  const deployments = [];
  for (const environment of cEnvironmentNames(c)) {
    const targetEnv = {
      ...env,
      TF_VAR_environment: environment,
      TF_DATA_DIR: resolve(".rt-app/terraform-" + environment),
    };
    const targetPlan = resolve(".rt-app/" + environment + ".plan");
    host.progress("Terraform: " + environment);
    await host.run(
      "terraform",
      [
        "-chdir=infra/aws",
        "init",
        "-reconfigure",
        "-input=false",
        "-backend-config=bucket=" + bootstrap.StateBucket,
        "-backend-config=key=" + environment + "/terraform.tfstate",
        "-backend-config=region=" + c.region,
        "-backend-config=encrypt=true",
        "-backend-config=use_lockfile=true",
      ],
      targetEnv,
    );
    await host.run(
      "terraform",
      ["-chdir=infra/aws", "plan", "-input=false", "-out=" + targetPlan],
      targetEnv,
    );
    await host.run(
      "terraform",
      ["-chdir=infra/aws", "apply", "-input=false", targetPlan],
      targetEnv,
    );
    const outputs = JSON.parse(
      String(
        await host.run(
          "terraform",
          ["-chdir=infra/aws", "output", "-json", "deployment"],
          targetEnv,
        ),
      ),
    );
    deployments.push(
      await publishEnvironment(
        c,
        environment,
        outputs,
        host,
        targetEnv,
        rootPassword,
        input.modules,
      ),
    );
  }
  const variables = {
    AWS_REGION: c.region,
    RT_APP_NAME: c.stack,
    TF_STATE_BUCKET: bootstrap.StateBucket,
    MAIL_FROM: c.mailFrom,
    RT_APP_MULTI_ENVIRONMENT: String(c.multiEnvironment ?? false),
    ...(c.multiEnvironment ? {AWS_ROLE_DEVELOP: bootstrap.DevelopRole, AWS_ROLE_STAGE: bootstrap.StageRole} : {}),
    AWS_ROLE_PROD: bootstrap.ProdRole,
  };
  let githubConfigured = false;
  const token = process.env.GH_TOKEN;
  if (token) {
    host.progress("Configuring GitHub Actions variables");
    for (const [name, value] of Object.entries(variables)) {
      const base =
        "https://api.github.com/repos/" + c.repository + "/actions/variables";
      const headers = {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "content-type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      const check = await fetch(base + "/" + name, { headers });
      if (!check.ok && check.status !== 404)
        throw new Error(
          "GitHub: could not read variables (" + check.status + ")",
        );
      const response = await fetch(check.ok ? base + "/" + name : base, {
        method: check.ok ? "PATCH" : "POST",
        headers,
        body: JSON.stringify({ name, value }),
      });
      if (!response.ok)
        throw new Error(
          "GitHub: could not save variables (" + response.status + ")",
        );
    }
    githubConfigured = true;
  }
  const result = {
    provider: "aws",
    engine: "terraform",
    status: "ready",
    repository: c.repository,
    deployments,
    multiEnvironment: c.multiEnvironment ?? false,
    githubConfigured,
    githubVariables: variables,
    adminUrl: deployments.find((d) => d.environment === "prod")!.adminUrl,
  };
  await host.save(result);
  host.progress(
    "Admin and public site published in " + cEnvironmentNames(c).join(", ") + ". Push the code and workflows to the repository to enable CI/CD.",
  );
  return result;
}

export function cEnvironmentNames(config: InstallationConfig): ("develop" | "stage" | "prod")[] {
  return config.multiEnvironment ? ["develop", "stage", "prod"] : ["prod"];
}
