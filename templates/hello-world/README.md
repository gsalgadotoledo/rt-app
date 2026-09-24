# Hello World RT-App
Full stack · node-ts. Requires Node 22.14+ and Rust/Cargo for the local CLI; AWS setup also requires Terraform.

```sh
# Install
npm install
# Local — no AWS credentials needed
npm run dev
# AWS installation wizard (administrative credentials; default: us-east-1)
export RT_APP_BOOTSTRAP_ACCESS_KEY_ID='YOUR_ACCESS_KEY_ID'
export RT_APP_BOOTSTRAP_SECRET_ACCESS_KEY='YOUR_SECRET_ACCESS_KEY'
export AWS_REGION='us-east-1'
# Temporary credentials only: export RT_APP_BOOTSTRAP_SESSION_TOKEN='YOUR_SESSION_TOKEN'
ADMIN_PASSWORD='YOUR_STRONG_ADMIN_PASSWORD' npm run cloud
# Deployed URLs
npm exec -- rta urls
```
