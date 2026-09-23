# Datos: contratos portables y especializaciones

Decisión de diseño, todavía no refactorización de todos los adaptadores existentes.

## Capas de contrato

```text
RelationalStore (subconjunto portable, definido y probado)
  ├─ implementación PostgreSQL
  ├─ implementación SQLite
  └─ implementación MySQL

PostgreSQLStore (conserva el contrato portable + capacidades PostgreSQL)
  ├─ driver/implementación A
  └─ driver/implementación B optimizada

DocumentStore      KeyValueStore      GraphStore
  └─ adaptadores     └─ adaptadores      └─ adaptadores
```

La misma implementación PostgreSQL puede satisfacer tanto RelationalStore como PostgreSQLStore. Un consumidor que necesita solo el primero no recibe permiso conceptual para depender de extensiones; otro consumidor puede requerir explícitamente PostgreSQL. Reemplazar A por B conserva el comportamiento observable, no solo los nombres de métodos. No se garantiza que cualquier proveedor SQL satisfaga todos los contratos.

## Qué debe ser portable

Definir un subconjunto concreto: tipos soportados, filtros, orden, paginación, resultados y errores. Añadir contratos separados para transacciones, búsqueda, vector search o streaming. Evitar prometer portabilidad de una cadena arbitraria de SQL: dialectos, placeholders, tipos y funciones difieren. Un escape `postgres.rawQuery()` debe marcar la dependencia específica del consumidor.

Las optimizaciones deben preservar semántica: orden estable, tratamiento de NULL, precisión decimal, aislamiento, unicidad y consistencia. Solo anunciar una capacidad cuando pase su suite contractual. Una implementación más rápida pero con garantías diferentes es otro perfil de capacidad, no un reemplazo transparente.

Para NoSQL no usar una interfaz universal de operaciones arbitrarias. DocumentStore, KeyValueStore y GraphStore expresan modelos distintos. Si users solo necesita UserRepository, ese contrato de dominio puede tener implementaciones SQL/documentales, siempre que ambas cumplan sus garantías (por ejemplo unicidad de email). Esto suele dar más libertad que filtrar toda la base de datos hacia el negocio.

## Validación de la composición

El futuro resolvedor debe comparar `requires` y `provides`, versiones, plataformas y garantías. Un módulo que requiere `postgres.vector-search` debe fallar al seleccionar un proveedor sin esa capacidad, antes de empezar a atender tráfico. Los manifiestos actuales exponen capabilities informativas, pero ese resolvedor semántico completo aún no está implementado. Los bindings del runtime actual validan identidad, referencias y orden, no la conformidad funcional del proveedor.

Cambiar un proveedor puede ser: (a) implementación sobre los mismos datos y contrato, (b) elección inicial sin datos, (c) traslado entre bases. Solo el tercer caso necesita migrador de datos; el primer caso aún requiere comprobar opciones, versión, extensiones y esquema. Las migraciones versionadas se publican por dialecto/perfil del módulo; no se traducen automáticamente SQL PostgreSQL a otro dialecto.

Aplicar el mismo principio a UI: un modelo de formulario es el contrato compartido; React/Vue/DOM son presentaciones diferentes. Una vista específicamente SwiftUI puede exponer además capacidades de plataforma sin obligar a todos los renderers a imitarlas.
