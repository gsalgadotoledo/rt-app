# Idempotencia persistida en RT-App

`RTAppIdempotentModule.executeIdempotent(request, work)` permite que las clases hijas protejan una operación. También se puede usar `RTAppIdempotencyModule.execute` por composición, sin herencia. El paquete `@gsalgadotoledo/rt-app-idempotency` no depende de Node ni de PostgreSQL; depende del contrato `RTAppIdempotencyStore`. Requiere Web Crypto (disponible en Node 20+ y contextos seguros de navegador); el adaptador PostgreSQL se ejecuta exclusivamente en el backend.

## Separación de responsabilidades

- `@gsalgadotoledo/rt-app-core`: ciclo de vida, registro e inyección. No importa ni exporta idempotencia.
- `@gsalgadotoledo/rt-app-idempotency`: contratos, claves, ejecución, estados y base opcional `RTAppIdempotentModule`.
- `@gsalgadotoledo/rt-app-idempotency-postgres`: persistencia y migración PostgreSQL; depende de los contratos del paquete especializado.

La aplicación configura los bindings. La dependencia va del paquete especializado hacia el core; nunca al revés. Para migrar código anterior, importar los símbolos de idempotencia desde `@gsalgadotoledo/rt-app-idempotency` y cambiar la clase base a `RTAppIdempotentModule` cuando se necesite el helper heredado.

También se puede inyectar `idempotency: RTAppIdempotencyExecutor` y llamar `this.idempotency.execute(...)` desde cualquier módulo. Esta composición permite conservar otra clase base; la clase especializada solo aporta comodidad y validación de configuración.

## Ejemplo de clase hija

```ts
import { createRTApp } from '@gsalgadotoledo/rt-app-core';
import { RTAppIdempotentModule, RTAppIdempotencyModule } from '@gsalgadotoledo/rt-app-idempotency';
import { RTAppPostgresIdempotencyStore } from '@gsalgadotoledo/rt-app-idempotency-postgres';

class Payments extends RTAppIdempotentModule {
  gateway!: {
    charge(input: { amount: number; currency: string }, options: { idempotencyKey: string }): Promise<{ id: string }>;
  };
  init() {}

  charge(actor: { tenantId: string; userId: string }, orderId: string,
         input: { amount: number; currency: string }) {
    // El actor proviene de la sesión autenticada. Autorizar la orden y validar
    // importe/moneda desde datos confiables ANTES de llamar este método.
    return this.executeIdempotent({
      scope: JSON.stringify(['shop', actor.tenantId, actor.userId, 'charge', 'v1']),
      key: orderId,
      input,
    }, ({ input: snapshot, idempotencyKey }) =>
      this.gateway.charge(snapshot, { idempotencyKey }));
  }
}

// paymentGateway implementa el contrato anterior y envía la clave al proveedor.
const rtApp = createRTApp({
  ledger: { module: RTAppPostgresIdempotencyStore, connectionString: process.env.DATABASE_URL },
  idempotency: { module: RTAppIdempotencyModule, bindings: { store: 'ledger' } },
  payments: { module: Payments, gateway: paymentGateway, bindings: { idempotency: 'idempotency' } },
});
await rtApp().loadAll();
```

`paymentGateway` es una dependencia suministrada por la aplicación; el ejemplo no envía pagos reales. Al inicializar propiedades para `bindings`, usar campos propios (por ejemplo `gateway = undefined` con un tipo explícito); `declare` no crea un campo en JavaScript. El campo heredado `idempotency` ya está inicializado por la clase base.

Cada reintento utiliza el mismo `orderId`. Una orden nueva utiliza otra clave. El scope identifica aplicación, actor autenticado, operación y versión; nunca confiar en un tenant/user arbitrario del body. Autenticación y autorización deben ocurrir también antes de devolver resultados guardados. No reutilizar scope/clave entre contratos de resultado distintos.

## Garantías y estados

| Estado encontrado | Acción |
| --- | --- |
| No existe | Reclamar atómicamente y persistir `pending` antes de ejecutar |
| `completed`, mismo input | Devolver resultado JSON guardado, sin ejecutar |
| Misma clave, otro input | Error `CONFLICT` |
| `pending` | Error `PENDING`; otra ejecución está trabajando o fue interrumpida |
| `uncertain` | Error `UNCERTAIN`; reconciliación necesaria |

Se compara un SHA-256 del JSON canónico. Se copia el input antes del primer `await`; la operación debe usar `context.input`, no el objeto original capturado. Se rechazan valores que JSON no representa fielmente, como `undefined`, `NaN`, fechas y ciclos. Los resultados también deben ser JSON. La tabla guarda el hash y el resultado mínimo; no almacenar secretos o datos de tarjeta en resultados.

Las instancias comparten la misma base/tabla. PostgreSQL reclama mediante una clave única `(scope,key)` y `INSERT ... ON CONFLICT DO NOTHING`; las actualizaciones verifican el propietario. El cliente inyectado debe ejecutar consultas confirmadas con autocommit y visibilidad READ COMMITTED: no envolver el callback externo en una transacción del ledger. Una implementación que devuelve `acquired` antes de confirmar la transacción viola el contrato.

Si falla el almacenamiento antes de reclamar, no se invoca la operación. Si falla el callback o la confirmación del resultado, se intenta marcar `uncertain`. Si también falla ese guardado, permanece `pending`. Un resultado confirmado no se sobrescribe si se pierde su acuse de recibo.

No hay caducidad, takeover ni borrado automático. Un proceso muerto puede dejar `pending` indefinidamente: se sacrifica disponibilidad para evitar repetir un posible cobro. Los adaptadores de transporte pueden mapear `PENDING` a una respuesta temporal y `CONFLICT` a un conflicto; nunca cambiar automáticamente de clave para evadir estos errores.

## Migración y operación

El paquete del adaptador contiene `migrations/postgresql/V1__idempotency.sql` y publica su manifiesto. `apps/main/rt-app.migrations.json` lo selecciona, con historial separado `rt_app_idempotency_schema_history`; el historial legacy no se modifica.

```sh
npm run migrate:plan
npm run migrate -- local
```

El segundo comando requiere configurar el destino PostgreSQL y Flyway/Docker como en el resto del proyecto. `init()` no crea tablas. Esta implementación no ejecutó migraciones contra bases externas. Otras aplicaciones deben seleccionar el manifiesto del adaptador en su propia configuración de migraciones.

Mantener el ledger duradero y compartido. Eliminar registros, restaurar un backup anterior a un cobro o apuntar un servidor a otra base permite repetir operaciones; la retención y recuperación forman parte de la garantía operativa.

## Alcance de pagos y recuperación

El ledger por sí solo no da una transacción atómica con Stripe u otro servicio externo. Se deriva una clave estable `rtapp-<sha256(scope,key)>` que el gateway debe enviar al proveedor. Stripe admite claves en POST, compara parámetros y puede eliminar claves después de al menos 24 horas: [contrato oficial](https://docs.stripe.com/api/idempotent_requests). No asumir que la deduplicación del proveedor dura para siempre.

Ante un estado incierto, consultar/reconciliar el proveedor por su referencia estable antes de decidir si completar el registro o realizar otra operación. Esta versión no incluye una API administrativa para resolver estados inciertos; tampoco los desbloquea automáticamente. Una futura resolución debe comprobar propiedad/estado y registrar auditoría. Operaciones con varios efectos necesitan claves por paso y coordinación tipo outbox/saga; envolver varios cobros en un callback no los vuelve atómicos.

El `PaymentsModule` legacy todavía usa `MOCK_USER` y varias llamadas Stripe sin clave; no queda protegido automáticamente por este cambio. Su adopción requiere identidad autenticada, identificadores estables por operación y propagación de la clave al gateway. La funcionalidad del paquete especializado y su uso por clases hijas sí están implementados y probados.

## Verificación

Las pruebas ejecutan el SQL real con PGlite, incluyendo competencia entre dos instancias del adaptador, persistencia en disco y reapertura, conflictos, timeouts, propietario incorrecto, resultado inválido, almacenamiento caído y pérdida del acuse de recibo. PGlite no sustituye pruebas de carga, conexiones concurrentes y failover de un clúster PostgreSQL de producción. El bloqueo entre conexiones se apoya en [las garantías de PostgreSQL para INSERT/ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html).
