# Example API (Python)

Every native module (one file per module in `modules/`) on an in-memory store, in local mode (owner endpoints under `/admin/app`,
no login). `app.py` is the composition root: change one line to swap the store. `modules/identity.py` serves users and
sign-in (`/auth/login`, `/auth/refresh`, `/auth/sessions`, `/auth/logout`…); its access tokens authenticate the other
modules' protected endpoints.

Run from this folder with Python 3.11+ and `rt-app/core-python/src` on `PYTHONPATH`
(`sh ../../../spec/hosts/python.sh` does both):

```sh
# 1. HTTP server on 127.0.0.1:$PORT (default 4010)
PORT=4010 sh ../../../spec/hosts/python.sh -m rt_app.web serve app:app

# 2. Lambda: deploy with handler `lambda_function.handler`; locally, serve the same handler
#    behind HTTP (each request becomes an API Gateway v2 event)
PORT=4011 sh ../../../spec/hosts/python.sh -m rt_app.web lambda-local app:app

# 3. CLI: one request, prints the JSON body (exit 1 when the status is 400 or more)
sh ../../../spec/hosts/python.sh -m rt_app.web call app:app PUT /admin/app/feature-flags/checkout \
  --body '{"version": null, "description": "", "enabled": true, "public": true, "rollout": 100, "subjects": []}'
```

The same `feature-flags-api` contract validates modes 1 and 2:
`npm run contracts -- --target python,python-lambda` from the repository root.
