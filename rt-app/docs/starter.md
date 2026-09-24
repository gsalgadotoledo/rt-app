# Alcance del starter

## Usuarios y Home

La aplicación incluye usuarios, login por contraseña/código de correo, recuperación
de contraseña, perfil y contenido público Home. `users` y `auth` implementan el
dominio de usuarios; `content` implementa Home. `acl` e `infra` son soporte del core.
La selección está en `modules.json`. El módulo de ejemplo Tareas permanece disponible
en el framework, pero no forma parte de esta aplicación por defecto.

El correo se simula en local y usa AWS SES en producción. Verifica el remitente en
la región de instalación; en sandbox SES también deben verificarse los destinatarios.
El admin local abre sin contraseña; el remoto usa ADMIN_PASSWORD, sin email ni tabla propia.
Desde allí puedes crear usuarios de la aplicación y editar Home; sus sesiones están aisladas.

## Infraestructura por responsabilidad

`infra/aws/main.tf` declara la tabla de datos del starter y conecta módulos Terraform
reutilizables: admin, sitio público y API. Las implementaciones de esos recursos
están en `rt-app`. No se copia infraestructura del admin dentro de cada aplicación.
Un único estado por entorno mantiene las dependencias; separar carpetas no implica
separar el ciclo de despliegue ni duplicar recursos. `moved.tf` conserva las direcciones
del estado anterior al extraer los módulos y debe mantenerse para instalaciones existentes.

El core define el hosting privado del admin en `rt-app/packages/infra/terraform/aws/admin`.
El bootstrap de estado/OIDC y los componentes Lambda/API y S3/CloudFront viven en
`rt-app/packages/infra/terraform/aws`. Ambos frontends llaman a la misma API; esta puede ejecutarse en
Node local o Lambda. El Terraform del starter sigue declarando su composición, pero
no implementa los recursos internos del admin.

Las credenciales exportadas en el terminal se leen por la cadena de credenciales AWS
del proceso; no se escriben en HCL ni en variables Terraform. Los datos de configuración
(región, aplicación, remitente y repositorio) parametrizan el despliegue.

## Extender

Añade el código del módulo al framework o instala su paquete, registra su Feature en
la composición y habilítalo en `modules.json`. Si necesita recursos propios, añádelos a
`infra/aws` y pasa sus referencias al módulo. Las migraciones pertenecen al módulo y
se ejecutan en el despliegue, no en cada request. Mantén cambios de esquema compatibles
con la versión anterior durante la actualización.

`apps/lambda-ts/build.mjs` genera el bundle desde cualquier directorio; puede ejecutarse
con `npm run lambda:build` o `npm run bundle -w @gsalgadotoledo/rt-app-lambda-ts`. La publicación CI vive
en el comando `rta deploy`. Las herramientas genéricas de workspaces están en el core.

## Pruebas junto a su implementación

No hay una carpeta de tests en la raíz. Cada app o paquete guarda y ejecuta sus
pruebas dentro de su propio directorio. Las pruebas de composición entre módulos
pertenecen al paquete framework (`rt-app/tests`); las del starter local están en
`apps/server/tests`. Las pruebas Terraform permanecen junto a su configuración.

`npm test` compila los workspaces y ejecuta sus scripts de pruebas. Para repetir
solo un grupo después del build:

```sh
npm test -w @gsalgadotoledo/rt-app-lambda-ts
```

`npm run test:dynamo` ejecuta las pruebas de integración del adaptador DynamoDB,
ubicadas en `rt-app/packages/dynamodb/tests`; requiere DynamoDB Local. Estas pruebas se ejecutan desde el repositorio del framework, no desde la aplicación generada. En local:

```sh
DYNAMODB_TEST_ENDPOINT=http://127.0.0.1:8000 AWS_ACCESS_KEY_ID=localtest AWS_SECRET_ACCESS_KEY=localtest AWS_REGION=us-east-1 npm run test:dynamo
```

## Frontend de la aplicación

`apps/spa` contiene el frontend público. Incluye React como punto de partida,
pero puede reemplazarse por otra tecnología. El admin continúa dentro del core.
Para conservar la publicación actual, el frontend debe ofrecer un script `build`
que genere archivos estáticos en `dist`, incluyendo `index.html`, y usar la URL
de API proporcionada durante el build. Un frontend con servidor propio o SSR
requerirá adaptar también su despliegue; S3 sirve archivos estáticos.
