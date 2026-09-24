import test from "node:test";
import assert from "node:assert/strict";
import { install, validateModules } from "@gsalgadotoledo/rt-app-installer";
import { STSClient } from "@aws-sdk/client-sts";
import { IAMClient } from "@aws-sdk/client-iam";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { S3Client } from "@aws-sdk/client-s3";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
const config = {
  provider: "aws",
  region: "us-east-1",
  stack: "rt-app-install-test",
  repository: "owner/repo",
  mailFrom: "mail@example.test",
  adminOrigin: "",
};
const modules = ["content", "infra", "users", "auth", "acl"];
test("installer rejects unconfirmed deployments before calling cloud or commands", async () => {
  let calls = 0;
  await assert.rejects(
    install(
      { config, modules, confirmation: "wrong" },
      { run: async () => calls++ },
    ),
    /Confirm/,
  );
  assert.equal(calls, 0);
  assert.throws(() => validateModules(["auth"]), /Invalid/);
});
for (const multiEnvironment of [false,true]) test(`installer provisions ${multiEnvironment ? "three environments" : "production only"}`, async (t) => {
  const environments = multiEnvironment ? ["develop", "stage", "prod"] : ["prod"];
  const previous = { ...process.env },
    stores = new Map(),
    commands = [],
    uploaded = [],
    statuses = [];
  process.env.ADMIN_PASSWORD="Installer-Test-2026!";
  // Never inherit a developer's real GitHub token or perform network writes.
  if (multiEnvironment) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = 'test-only-github-token';
  const githubWrites = [];
  let githubReads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(String(url).startsWith('https://api.github.com/repos/owner/repo/actions/variables'));
    if (!options.method) return new Response('', {status: ++githubReads % 2 ? 404 : 200});
    githubWrites.push({method: options.method, ...JSON.parse(options.body)});
    return new Response('', {status: 200});
  });
  const secretsWritten=[];
  const table = (name) => {
    if (!stores.has(name)) stores.set(name, new MemoryStore());
    return stores.get(name);
  };
  t.after(() => {
    for (const k of Object.keys(process.env))
      if (!(k in previous)) delete process.env[k];
    Object.assign(process.env, previous);
  });
  t.mock.method(STSClient.prototype, "send", async () => ({
    Account: "123456789012",
    Arn: "arn:aws:iam::123456789012:user/installer",
  }));
  const output = (env) => ({
    CognitoUserPoolId: "us-east-1_test", CognitoClientId:"testclient", TableName: env + "-app",
    AdminPasswordSecretArn: env + "-admin-password",
    JwtSecretArn: env + "-jwt",
    AwsCredentialsSecretArn: env + "-infra",
    ApiUrl: "https://api.example.test",
    AdminBucketName: env + "-admin-bucket",
    PublicBucketName: env + "-public-bucket",
    AdminDistributionId: "cdn",
    PublicDistributionId: "public-cdn",
    AdminUrl: "https://admin.example.test",
    PublicUrl: "https://public.example.test",
  });
  t.mock.method(IAMClient.prototype, "send", async () => ({}));
  t.mock.method(SecretsManagerClient.prototype,"send",async command=>{
    if(command.constructor.name==="PutSecretValueCommand"){secretsWritten.push(command.input);return {};}
    return {SecretString:"test-jwt-secret".repeat(5)};
  });
  t.mock.method(DynamoDBDocumentClient.prototype, "send", async (command) => {
    const input = command.input;
    const store = table(
      input.TableName ?? input.TransactItems?.[0]?.Put.TableName,
    );
    if (command.constructor.name === "GetCommand")
      return { Item: await store.get(input.Key.pk, input.Key.sk) };
    if (command.constructor.name === "QueryCommand")
      return {
        Items: (await store.list(input.ExpressionAttributeValues[":pk"])).items,
      };
    if (command.constructor.name === "TransactWriteCommand") {
      await store.transact(
        input.TransactItems.map((item) => ({
          row: item.Put.Item,
          expected: item.Put.ExpressionAttributeValues?.[":v"] ?? null,
        })),
      );
      return {};
    }
    throw new Error("Unexpected command");
  });
  t.mock.method(S3Client.prototype, "send", async (command) => {
    uploaded.push(command.input);
    return {};
  });
  t.mock.method(CloudFrontClient.prototype, "send", async () => ({}));
  let saved;
  const result = await install(
    {
      config: {...config, multiEnvironment},
      modules,
      confirmation: config.stack,
      expectedAccount: "123456789012",
    },
    {
      async bindInstallation(identity) {
        assert.equal(identity.account, "123456789012");
        return { managesOidc: false };
      },
      async run(command, args, env) {
        commands.push({ command, args, env });
        if (args.includes("output"))
          return JSON.stringify(
            args.includes("bootstrap")
              ? { StateBucket: "state", DevelopRole: "develop", StageRole: "stage", ProdRole: "prod" }
              : output(env.TF_VAR_environment),
          );
      },
      async configureModules(ids) {
        assert.deepEqual(ids, modules);
      },
      async assets() {
        return [
          { path: "index.html", body: new Uint8Array(), type: "text/html" },
          {
            path: "assets/app.js",
            body: new Uint8Array(),
            type: "text/javascript",
          },
        ];
      },
      async save(value) {
        saved = value;
      },
      progress(message) {
        statuses.push(message);
      },
    },
  );
  assert.equal(result.deployments.length, environments.length);
  assert.equal(result.githubConfigured, !multiEnvironment);
  if (!multiEnvironment) {
    assert.ok(githubWrites.some(write => write.method === 'PATCH'));
    assert.ok(githubWrites.some(write => write.method === 'POST'));
    assert.ok(githubWrites.some(write => write.name === 'AWS_ROLE_PROD' && write.value === 'prod'));
  }
  assert.equal(saved.status, "ready");
  for (const env of environments) {
    assert.equal(stores.has(env+"-admin"),false);
    assert.equal((await table(env + "-app").list("USERS")).items.length, 0);
    assert.ok(
      commands.some((c) =>
        c.args.includes("-backend-config=key=" + env + "/terraform.tfstate"),
      ),
    );
  }
  assert.equal(secretsWritten.length,environments.length);
  assert.ok(secretsWritten.every(s=>s.SecretString.startsWith("scrypt:")));
  assert.ok(commands.every(c=>!c.env?.ADMIN_PASSWORD && !c.env?.ADMIN_PASSWORD_VERIFIER));
  const active = uploaded.filter((a) => !a.Key.startsWith("releases/"));
  assert.equal(active.length, environments.length * 4);
  for (let i = 0; i < active.length; i += 2) {
    assert.equal(active[i].Key, "assets/app.js");
    assert.equal(active[i + 1].Key, "index.html");
    assert.equal(active[i + 1].CacheControl, "no-cache");
  }
  assert.equal(commands.at(-1).env.RT_APP_API_URL, output("prod").ApiUrl);
  assert.equal(commands.at(-1).env.RT_APP_ENVIRONMENT, "prod");
  assert.equal(commands.at(-1).env.JWT_SECRET, undefined);
  const applies = commands.filter((c) => c.args.includes("apply"));
  assert.equal(applies.length, environments.length + 1);
  assert.ok(applies.every((c) => c.args.at(-1).endsWith(".plan")));
  assert.doesNotMatch(
    JSON.stringify(saved),
    /password|secretAccessKey|JWT_SECRET/,
  );
});
