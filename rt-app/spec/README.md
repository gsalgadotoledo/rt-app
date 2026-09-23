# Contratos del core RT-App

El starter actual utiliza TypeScript/Node, DynamoDB y AWS. Ejecuta la misma API en
el servidor local o en Lambda. El admin React y su infraestructura se distribuyen
con el core; la aplicación aporta su configuración y los módulos habilitados.

- [Composición estática](static-composition.md): diseño de composición e inicialización.
- [Idempotencia](idempotency.md): contrato y límites de las operaciones repetidas.
- [Capacidades de datos](data-capabilities.md): contratos especializados y portabilidad.
- [UI](ui-runtime.md): propuestas para extender componentes.
- `conformance/`: vectores de contrato utilizados por las pruebas del core.

Estos documentos incluyen propuestas de evolución; no son una lista de plataformas
o adaptadores de producción disponibles. No se incluye un runtime Python ni aplicaciones
para otras plataformas en este starter.

La infraestructura vigente está en `../infra/aws` y `../admin/infra/aws`. La aplicación
la compone desde `../../infra/aws`. Las migraciones implementadas son de documentos
DynamoDB, con memoria para pruebas, y se coordinan mediante el paquete contracts.
La guía operativa vigente es [instalación](../../docs/installation.md).
