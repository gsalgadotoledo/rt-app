# RT-App framework

Código reutilizable, separado de las entradas de aplicación. src implementa la
composición del backend; admin contiene myadmin; installer coordina instalación;
packages contiene los módulos reutilizables. No hay dependencias hacia apps.

El package @gsalgadotoledo/rt-app-framework exporta createApplication, createProductionApplication
y seedDemo. createApplication admite features adicionales; main.js configura la
aplicación consumidora y modules.json selecciona los ids. El admin permite aportar
componentes mediante mountAdmin(element, components).

Los paquetes internos se resuelven hoy como workspaces. Este árbol es la frontera
del framework, no una publicación npm ya hecha: antes de publicar hay que fijar
versiones, licencias y publicar las dependencias internas o empaquetarlas juntas.

La infraestructura AWS reutilizable está en infra/aws: bootstrap de estado/OIDC,
API Lambda y hosting S3/CloudFront. admin/infra/aws declara exclusivamente los
recursos del admin (interfaz; sin tabla de usuarios). La aplicación consumidora compone estos
módulos y declara sus propios datos en infra/aws de la raíz del starter.
Las credenciales se reciben mediante el entorno AWS del instalador, nunca como
valores persistidos en los archivos Terraform. scripts contiene herramientas del core.

El admin se inicia con `npm run dev -w @gsalgadotoledo/rt-app-myadmin`. Su build web está en
`rt-app/admin/dist/web`; el backend permanece en `dist/backend`. El build de UI
no borra los artefactos del backend. No existe una app admin fuera del core.

## Language cores

```text
rt-app/
  core-ts/       @gsalgadotoledo/rt-app-core — existing TypeScript module manager
  core-go/       rt.local/core-go — typed constructors + singleton providers
  core-python/   rt-app-core / rt_app_core — factories, Protocol, sync/async providers
  admin/         existing TypeScript admin
  packages/      feature modules, project generator and desktop manager
```

Each language core has its own package metadata, tests and examples. Nothing has been published to a public registry. Go's `rt.local/core-go` path is a development identity with a local `replace`; choose the real repository path before publishing. Python builds a wheel; TypeScript builds an npm tarball. The generator/desktop copy these cores into new projects; Python/Go hello endpoints now use their respective providers. Existing generated projects are not automatically migrated.

Dependency construction is explicit and application-owned. The native cores are intentionally small: they provide singleton initialization/lifecycle, not native ports of all TypeScript modules. Admin/auth/CRUD still use the local Node core when a Python or Go backend is selected.
