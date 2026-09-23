/** Installation metadata; credentials never belong here. */
export const infrastructureProviders = [
  { id: "aws", title: "AWS", available: true, nosql: "dynamodb" },
] as const;
export const installationSteps = [
  {
    title: "1. AWS",
    detail: "This release uses AWS and DynamoDB. No provider selection is needed.",
  },
  {
    title: "2. Identity and permissions",
    detail:
      "Use an AWS SSO profile or temporary IAM credentials. Never use the AWS root user. The admin root is a separate identity.",
  },
  {
    title: "3. Requirements",
    detail:
      "Node 22.12+, Terraform 1.11+ and a verified SES sender in the selected region. Prepare a GitHub repository.",
  },
  {
    title: "4. Review",
    detail:
      "npm run setup opens the local wizard. Review the AWS account and planned resources before confirming. Production is created by default; multi-environment adds develop and stage. Charges may apply.",
  },
  {
    title: "5. Resources",
    detail:
      "Terraform creates remote state, OIDC roles and the selected environments with Lambda, API Gateway, an application DynamoDB table per environment, private S3 and CloudFront.",
  },
  {
    title: "6. Admin root",
    detail:
      "The installer migrates data, configures the ADMIN_PASSWORD verifier and publishes the admin and public React site. GitHub Actions preserves that identity and deploys develop, stage or prod based on the branch and enabled mode.",
  },
];
export const awsPermissionGroups = [
  {
    title: "Initial bootstrap",
    detail:
      "S3 for the state bucket; IAM to read/create the GitHub OIDC provider, roles, policies and permission boundaries. The installer's account also needs permissions to deploy resources in the selected environments.",
  },
  {
    title: "Environment resources",
    detail:
      "Lambda, API Gateway v2, DynamoDB, Secrets Manager, CloudWatch Logs, S3 and CloudFront: create, update, read, tag and delete for replacements. IAM only for the execution role and PassRole to Lambda. See rt-app/infra/aws/bootstrap/main.tf and docs/installation.md.",
  },
  {
    title: "Migration and publishing",
    detail:
      "DynamoDB GetItem, Query and TransactWriteItems on the application table; Secrets Manager GetSecretValue/PutSecretValue to initialize JWT and the admin verifier; S3 PutObject for both sites and CloudFront CreateInvalidation.",
  },
  {
    title: "Runtime and CI",
    detail:
      "Lambda receives permissions limited to its data, secrets, logs and SES. GitHub Actions assumes a separate OIDC role per branch, without persistent AWS keys. The optional GitHub token only configures repository variables (Variables: write).",
  },
];
