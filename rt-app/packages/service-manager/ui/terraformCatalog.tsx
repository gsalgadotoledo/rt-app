import React from "react";

/**
 * How Terraform types look in the resource map: provider logos, a category and an icon per
 * service. Unknown types still render (category "Other", a generic icon, a readable label).
 */

export type CategoryId = "compute" | "hosting" | "storage" | "database" | "network" | "api" | "identity" | "events" | "monitoring" | "cost" | "payments" | "other" | "data" | "outputs";
export const CATEGORIES: { id: CategoryId; label: string; color: string; icon: IconName }[] = [
  { id: "compute", label: "Compute", color: "#ED7100", icon: "lambda" },
  { id: "hosting", label: "Hosting & frontend", color: "#F43F5E", icon: "rocket" },
  { id: "api", label: "APIs", color: "#E7157B", icon: "api" },
  { id: "database", label: "Databases", color: "#4D6BFE", icon: "database" },
  { id: "storage", label: "Storage", color: "#7AA116", icon: "bucket" },
  { id: "network", label: "Networking & CDN", color: "#8C4FFF", icon: "globe" },
  { id: "identity", label: "Identity & security", color: "#DD344C", icon: "shield" },
  { id: "events", label: "Events & messaging", color: "#D946EF", icon: "bolt" },
  { id: "monitoring", label: "Monitoring & logs", color: "#0EA5E9", icon: "chart" },
  { id: "cost", label: "Cost & budgets", color: "#16A34A", icon: "dollar" },
  { id: "payments", label: "Payments", color: "#635BFF", icon: "card" },
  { id: "other", label: "Other", color: "#64748B", icon: "gear" },
  { id: "data", label: "Lookups · data sources", color: "#94A3B8", icon: "search" },
  { id: "outputs", label: "Outputs", color: "#14B8A6", icon: "output" },
];

type Service = [prefix: string, service: string, category: CategoryId, icon: IconName];
/** Longest matching prefix wins, so aws_cloudwatch_event_ beats aws_cloudwatch_. */
const SERVICES: Service[] = [
  ["aws_lambda_", "Lambda", "compute", "lambda"],
  ["aws_instance", "EC2", "compute", "server"],
  ["aws_launch_template", "EC2", "compute", "server"],
  ["aws_autoscaling_", "Auto Scaling", "compute", "server"],
  ["aws_ecs_", "ECS", "compute", "container"],
  ["aws_ecr_", "ECR", "compute", "container"],
  ["aws_apprunner_", "App Runner", "compute", "container"],
  ["aws_amplify_", "Amplify", "hosting", "rocket"],
  ["aws_s3_", "S3", "storage", "bucket"],
  ["aws_efs_", "EFS", "storage", "disk"],
  ["aws_dynamodb_", "DynamoDB", "database", "table"],
  ["aws_rds_", "RDS", "database", "database"],
  ["aws_db_", "RDS", "database", "database"],
  ["aws_elasticache_", "ElastiCache", "database", "database"],
  ["aws_cloudfront_", "CloudFront", "network", "globe"],
  ["aws_route53_", "Route 53", "network", "dns"],
  ["aws_vpc", "VPC", "network", "network"],
  ["aws_subnet", "VPC", "network", "network"],
  ["aws_security_group", "VPC", "network", "shield"],
  ["aws_internet_gateway", "VPC", "network", "network"],
  ["aws_nat_gateway", "VPC", "network", "network"],
  ["aws_route_table", "VPC", "network", "network"],
  ["aws_eip", "VPC", "network", "network"],
  ["aws_lb", "Load balancing", "network", "network"],
  ["aws_alb", "Load balancing", "network", "network"],
  ["aws_apigatewayv2_", "API Gateway", "api", "api"],
  ["aws_api_gateway_", "API Gateway", "api", "api"],
  ["aws_appsync_", "AppSync", "api", "api"],
  ["aws_iam_", "IAM", "identity", "key"],
  ["aws_cognito_", "Cognito", "identity", "user"],
  ["aws_secretsmanager_", "Secrets Manager", "identity", "lock"],
  ["aws_ssm_", "Parameter Store", "identity", "lock"],
  ["aws_kms_", "KMS", "identity", "key"],
  ["aws_acm_", "Certificates", "identity", "certificate"],
  ["aws_wafv2_", "WAF", "identity", "shield"],
  ["aws_cloudwatch_event_", "EventBridge", "events", "bolt"],
  ["aws_scheduler_", "EventBridge Scheduler", "events", "clock"],
  ["aws_sns_", "SNS", "events", "bell"],
  ["aws_sqs_", "SQS", "events", "queue"],
  ["aws_ses", "SES", "events", "mail"],
  ["aws_sfn_", "Step Functions", "events", "flow"],
  ["aws_cloudwatch_", "CloudWatch", "monitoring", "chart"],
  ["aws_xray_", "X-Ray", "monitoring", "chart"],
  ["aws_budgets_", "Budgets", "cost", "dollar"],
  ["aws_ce_", "Cost Explorer", "cost", "dollar"],
  ["aws_caller_identity", "Account", "other", "user"],
  ["aws_partition", "Account", "other", "user"],
  ["aws_region", "Account", "other", "globe"],
  ["stripe_product", "Stripe", "payments", "tag"],
  ["stripe_price", "Stripe", "payments", "dollar"],
  ["stripe_webhook", "Stripe", "payments", "bolt"],
  ["stripe_", "Stripe", "payments", "card"],
  ["cloudflare_", "Cloudflare", "network", "globe"],
  ["github_", "GitHub", "other", "git"],
  ["archive_", "Archive", "other", "archive"],
  ["random_", "Random", "other", "dice"],
  ["null_", "Null", "other", "gear"],
  ["terraform_", "Terraform", "other", "gear"],
  ["local_", "Local file", "other", "archive"],
  ["tls_", "TLS", "identity", "certificate"],
];

const words = (text: string) => text.split("_").filter(Boolean).join(" ");
const capital = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/** Service, readable label, category and icon for a Terraform type such as aws_s3_bucket_policy. */
export function describeType(type: string, kind: "resource" | "data" | "output" | string) {
  if (kind === "output") return { service: "Output", label: "Output", category: "outputs" as CategoryId, icon: "output" as IconName };
  const match = SERVICES.filter(([prefix]) => type.startsWith(prefix)).sort((a, b) => b[0].length - a[0].length)[0];
  const provider = type.split("_")[0];
  const rest = match ? type.slice(match[0].length).replace(/^_/, "") : type.slice(provider.length + 1);
  const service = match?.[1] ?? capital(provider);
  const label = capital(words(rest)) || capital(words(type.slice(provider.length + 1))) || service;
  return { service, label, category: (kind === "data" ? "data" : match?.[2] ?? "other") as CategoryId, icon: (match?.[3] ?? "cube") as IconName };
}

const ICONS = {
  lambda: "M6 20l5.5-10 M8 4h3l7 16h2",
  server: "M4 4h16v6H4z M4 14h16v6H4z M8 7h.01 M8 17h.01",
  container: "M3 7l9-4 9 4-9 4z M3 7v10l9 4 9-4V7 M12 11v10",
  rocket: "M12 2c3 2 5 6 5 10l-2 4H9l-2-4c0-4 2-8 5-10z M9 16l-3 4 M15 16l3 4 M12 9h.01",
  bucket: "M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2z M4 6l2 13c.2 1.1 2.8 2 6 2s5.8-.9 6-2l2-13",
  disk: "M4 5h16v14H4z M8 15h8 M16 9h.01",
  table: "M4 5h16v14H4z M4 10h16 M4 15h16 M10 5v14",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z",
  dns: "M4 4h16v6H4z M4 14h16v6H4z M8 7h4 M8 17h4 M16 7h.01 M16 17h.01",
  network: "M10 3h4v4h-4z M3 17h4v4H3z M10 17h4v4h-4z M17 17h4v4h-4z M12 7v10 M5 17v-3h14v3",
  api: "M9 3v5 M15 3v5 M6 8h12v3a6 6 0 0 1-12 0z M12 17v4",
  key: "M8 16a4 4 0 1 1 3.5-6 M11.5 10H21 M17 10v3 M20 10v2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c0-4 3.6-6 8-6s8 2 8 6",
  lock: "M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4 M12 15v2",
  certificate: "M4 4h16v11H4z M12 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M10 17.5L9 22l3-1.5 3 1.5-1-4.5",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4z M10 21h4",
  queue: "M4 6h16 M4 12h16 M4 18h10",
  mail: "M3 5h18v14H3z M3 6l9 7 9-7",
  flow: "M4 4h6v5H4z M14 15h6v5h-6z M7 9v3h10v3",
  chart: "M4 20V4 M4 20h16 M8 16l3-4 3 2 5-7",
  dollar: "M12 3v18 M16 7c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 3 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3",
  tag: "M3 12V3h9l9 9-9 9z M8 8h.01",
  card: "M3 6h18v12H3z M3 10h18 M7 15h4",
  git: "M6 3v12 M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9c0 5-6 4-12 6",
  archive: "M3 4h18v4H3z M5 8v12h14V8 M10 12h4",
  dice: "M4 4h16v16H4z M8.5 8.5h.01 M15.5 15.5h.01 M12 12h.01",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1",
  cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9",
  module: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5",
  output: "M5 12h14 M13 6l6 6-6 6",
};
export type IconName = keyof typeof ICONS;

export function TfIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ICONS.cube} />
    </svg>
  );
}

/** Small brand-colored marks for common providers; anything else gets its initial. */
export function ProviderLogo({ name, size = 28 }: { name: string; size?: number }) {
  const box = (bg: string, content: React.ReactNode) => (
    <svg className="rt-tf-logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill={bg} />
      {content}
    </svg>
  );
  switch (name) {
    case "aws":
      return box("#232F3E", <>
        <text x="16" y="17" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="11" fill="#fff">aws</text>
        <path d="M8 21c5 3 11 3 16 0" stroke="#FF9900" strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d="M22 19.2l2.3 1.6-1 2.5" stroke="#FF9900" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </>);
    case "stripe":
      return box("#635BFF", <text x="16" y="22.5" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="800" fontSize="18" fill="#fff">S</text>);
    case "cloudflare":
      return box("#F38020", <path d="M9 21h14a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.4-1.5A4 4 0 0 0 9 21z" fill="#fff" />);
    case "github":
      return box("#181717", <path d="M16 7a9 9 0 0 0-2.8 17.5c.4.1.6-.2.6-.4v-1.6c-2.5.5-3-1.1-3-1.1-.4-1-1-1.3-1-1.3-.8-.6.1-.6.1-.6.9.1 1.4 1 1.4 1 .8 1.4 2.1 1 2.6.8.1-.6.3-1 .6-1.2-2-.2-4.1-1-4.1-4.4 0-1 .3-1.8.9-2.4-.1-.2-.4-1.1.1-2.4 0 0 .8-.2 2.5.9a8.6 8.6 0 0 1 4.5 0c1.7-1.1 2.5-.9 2.5-.9.5 1.3.2 2.2.1 2.4.6.6.9 1.4.9 2.4 0 3.4-2.1 4.2-4.1 4.4.3.3.6.8.6 1.6v2.4c0 .2.2.5.6.4A9 9 0 0 0 16 7z" fill="#fff" />);
    case "google":
      return box("#fff", <text x="16" y="22.5" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="18" fill="#4285F4">G</text>);
    case "azurerm":
      return box("#0078D4", <path d="M14 8l-7 16h5l8-16z M17 13l-3 7 4 4h8z" fill="#fff" />);
    case "archive":
    case "random":
    case "null":
    case "local":
    case "tls":
    case "terraform":
      return box("#7B42BC", <path d="M9 7l6 3.5v7L9 14z M16.5 11l6-3.5v7l-6 3.5z M16.5 19.5l6-3.5v7l-6 3.5z" fill="#fff" />);
    default:
      return box("#475569", <text x="16" y="21.5" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="15" fill="#fff">{name.slice(0, 1).toUpperCase()}</text>);
  }
}
