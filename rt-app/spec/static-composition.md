# RT-App: composición estática e inicialización selectiva

## Decisión propuesta

Mantener contratos de capacidades comunes, con composición idiomática para cada lenguaje. No exigir un contenedor dinámico, reflexión, búsqueda por strings ni una clase base universal. La composición estática define constructores y conexiones explícitas; no significa que Python se convierta en un binario estático ni que no exista inicialización en ejecución.

Separar cuatro costes: distribución de archivos, importación/evaluación del código, construcción de objetos e inicialización de recursos (pools, SDK, modelos). Tener un paquete instalado no implica importarlo. Retrasar `init` no evita el coste de un import superior ya ejecutado.

## Estado inspeccionado

- TypeScript: `RTAppManager` calcula el grafo al cargar y asigna referencias en bindings. Una llamada de negocio sobre una referencia inyectada no atraviesa el contenedor.
- `apps/main/src/rtApp.ts` importa adaptadores de desarrollo y producción en el mismo archivo. Elegir una rama en `getConfig` no evita esos imports.
- `loadAll()` construye e inicializa todo el registro. `preloadAll()` selecciona módulos marcados y sus dependencias, pero no deshace imports ya ejecutados.
- Python experimental tiene un registro similar. No se reemplazó ese contrato ni el arranque Node en este cambio.

No hay mediciones que permitan atribuir un porcentaje de overhead al contenedor. Medir por separado proceso frío, imports, conexiones, memoria y requests calientes antes de decidir optimizaciones adicionales.

## Prototipo ejecutable Python

`runtimes/python/examples/static_app/composition.py` conecta explícitamente `ConsoleEmail` con `Notifications(email)`. No usa el registro dinámico. Los imports de implementación están dentro del método de arranque y el import para anotaciones está bajo `TYPE_CHECKING`.

```sh
PYTHONPATH=runtimes/python python3 -m examples.static_app
npm run test:python
```

```python
async with RTAppApplication() as app:
    # Una ruta /health podría responder sin acceder a notificaciones.
    notifications = await app.notifications()
    await notifications.welcome("persona@example.com", "Gustavo")
```

El constructor es liviano. El primer acceso crea una tarea compartida de inicialización; llamadas simultáneas esperan esa tarea. Se retiene el fallo para evitar duplicar efectos al reintentar. Cancelar un request no cancela la inicialización compartida. El cierre espera el arranque y libera recursos creados, incluso ante fallos parciales. La app pertenece a un solo event loop/proceso; no ofrece sincronización entre threads ni procesos. El servidor debe drenar requests antes del cierre. No se descarga el módulo Python después del request.

`await app.warmup()` ofrece arranque anticipado del mismo grafo para servidores sensibles a latencia o que deben fallar al arrancar si falta una dependencia. Las clases puramente computacionales no necesitan un `init` vacío. Este ejemplo es composición escrita a mano, no un generador de código ni un reemplazo de todo el backend.

## Evolución recomendada

1. Composiciones por aplicación/target: un CLI de migraciones no incluye correo o pagos; una Lambda selecciona su grafo alcanzable, no todo el monorepo.
2. Proveedores seleccionados explícitamente en código o generados desde configuración al preparar/buildar la aplicación. El cambio de proveedor puede requerir regeneración y nuevo despliegue.
3. Validar dependencias y ciclos durante esa generación, antes del despliegue. El generador no está implementado todavía.
4. Inicialización anticipada para dependencias críticas y diferida para capacidades opcionales. Las dependencias obligatorias de una operación también se inicializan: lazy no elimina dependencias reales.
5. Recursos compartidos con alcance de aplicación; usuario, transacción y metadata con alcance de request. No crear/destruir pools por request.

Para Python, usar imports locales explícitos y referencias directas; no introducir proxies transparentes globales. La [documentación de LazyLoader](https://docs.python.org/3/library/importlib.html#importlib.util.LazyLoader) advierte que diferir la ejecución de imports también difiere los errores. El prototipo no usa LazyLoader.

Para TypeScript, proponer entrypoints por target y `import()` explícito para grupos opcionales. La exclusión de código del artefacto depende del bundler y de los efectos laterales, no solo del contenedor. Para Go/Rust/Swift/Java, evaluar composición por constructores/factories y tipos propios del lenguaje; no trasladar el mecanismo Python literalmente. Estos backends no se implementaron en este cambio.

La carga diferida puede reducir trabajo de arranque y recursos nunca usados, pero añade latencia al primer uso. Los imports Python ejecutan código síncrono: un import pesado puede bloquear el event loop; para rutas sensibles, preferir precarga o aislamiento del trabajo. El patrón no demuestra una mejora de throughput sin benchmarks representativos.
