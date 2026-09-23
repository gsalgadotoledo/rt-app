# RT-App: UI portable, presentaciones específicas y código modificable

## Decisión

Separar la lógica del componente de su presentación. El modelo describe estado, validación, acciones y efectos. Un renderer traduce ese modelo al framework/plataforma. Esto permite cambiar React/Vue/DOM conservando el modelo; no convierte arbitrariamente cualquier aplicación React en SwiftUI.

La portabilidad tiene niveles:

1. **Contrato**: comportamiento, mensajes, configuración, diseño y pruebas. Puede compartirse entre lenguajes.
2. **Modelo ejecutable**: TypeScript puro para web, React Native y hosts compatibles. Python/Swift/Kotlin necesitan implementaciones propias o una frontera explícita de comunicación.
3. **Presentación**: React, Vue, DOM, SwiftUI, Compose, TUI. Se cambia o se copia y adapta.
4. **Plataforma**: navegación, archivos, permisos, cámara, teclado, foco, offline, IPC y distribución. Tiene adaptadores propios y no se oculta bajo una API que prometa lo imposible.

Una UI declarativa/schema-driven sirve para formularios, tablas y flujos comunes. No imponer un árbol visual universal para todas las experiencias: interacciones nativas y diseños particulares deben poder escribirse directamente con el toolkit elegido.

## Contratos implementados

- `RTAppModule`: `init()` obligatorio; `dispose()` opcional. El runtime conserva bindings/dependencias y cierra instancias construidas en orden inverso, incluso tras un arranque parcial. Los adaptadores heredados sin dispose siguen necesitando implementar su cierre.
- `RTAppBaseModule`: clase abstracta opcional para extender. No se obliga a heredar: implementar la interfaz también funciona y facilita integrar componentes de terceros.
- `RTAppComponentModule<Options, Component>`: añade `create(options)`. Es un contrato para módulos que crean componentes, no un requisito de renderizado para bases de datos o email.
- `RTAppComponent`: `dispose()` para liberar una instancia de UI.
- `RTAppStore`: `getSnapshot()` estable, `subscribe()` con unsubscribe y limpieza; permite conectar renderers distintos.

`@gsalgadotoledo/rt-app-ui-core` incluye `RTAppFormsModule` y `RTAppAgentModule`. Los módulos son fábricas singleton, **los formularios/sesiones son instancias por vista, usuario o ventana**. Dos formularios nunca comparten valores por accidente. El dueño de la vista llama a `component.dispose()`; cerrar todo el runtime cierra los componentes que sigan vivos. Desmontar un renderer solo cancela su suscripción: el modelo puede seguir vivo para montar otro renderer.

```ts
const rtApp = createRTApp({ forms: { module: RTAppFormsModule } });
await rtApp().loadAll();
const form = rtApp('forms').create({
  steps: [{ id: 'profile', title: 'Perfil', fields: [
    { name: 'name', label: 'Nombre', required: true },
  ] }],
});
// React: <RTAppFormView form={form} />
// Vue:   <RTAppVueFormView :form="form" />
// DOM:   mountRTAppForm(element, form)
```

Las instancias de formulario de SSR deben aislarse por solicitud, nunca quedar en una variable global compartida. El renderer React recibe snapshots de servidor pero la aplicación aún debe serializar/rehidratar el mismo estado; SSR/hidratación no se certifican en esta demo.

## Componentes actuales y límites

- Formulario: pasos lineales, campos de texto, validación required, avanzar/retroceder, estado inmutable, evento de finalización como `complete`. No envía datos por sí mismo. Faltan campos complejos, validación async, flujos condicionales, persistencia y una auditoría de accesibilidad.
- Sesión de agente: mensajes, pending/error, transporte inyectado, cancelación, descarte de respuestas tardías y aislamiento. La UI del agente está en React. No incluye razonamiento autónomo, tools privilegiadas, streaming, gestión de tokens ni conexión automática a un proveedor LLM.
- Demo: `apps/ui-playground` permite escribir en React, cambiar a Vue/DOM y mantener valores/paso. El agente usa un transporte simulado explícito. Ninguna credencial sale del backend.
- `dispose` del runtime: se espera al arranque ya solicitado, se cierran módulos en orden inverso, se agregan errores y se bloquean nuevas cargas. El host debe dejar de aceptar operaciones antes de cerrar. No ofrece drenaje automático de requests ni reentrancia de lifecycle.

## Usar, extender, componer o copiar

1. **Usar**: instalar/importar el paquete y configurar opciones/bindings. Recibe actualizaciones de la dependencia según el lockfile.
2. **Componer/decorar**: envolver el contrato para añadir validación, métricas o políticas. Preferido cuando evita acoplarse a detalles internos.
3. **Extender**: heredar de una clase pública para modificar puntos explícitos. Evitar cadenas profundas o depender de campos privados.
4. **Copiar fuente**: crear un paquete propio y asumir su mantenimiento. Cambiar el binding o import al nuevo paquete. Ya no recibe automáticamente los fixes del original.

Tool local implementada:

```sh
npm run component:copy -- @gsalgadotoledo/rt-app-ui-core @my/ui
npm install
npm run build -w @my/ui
npm run test -w @my/ui
```

Crea `packages/my-ui`, cambia la identidad, conserva tests y dependencias, deja el paquete privado y registra hashes/origen en `rt-app.origin.json`. Copia únicamente rutas autorizadas por `sourceDistribution` del manifiesto, conserva LICENSE/NOTICE cuando existen, rechaza symlinks/traversal y no sobrescribe carpetas. No ejecuta scripts ni instala dependencias por sí sola. La derivación queda marcada `requires-validation`; copiar código probado no certifica modificaciones futuras.

Los paquetes `ui-core`, `ui-react`, `ui-vue` y `ui-dom` declaran su herramienta de copia. El CLI es genérico; cada paquete expone metadata, no necesita distribuir un script privilegiado diferente. No hay instalación desde registros remotos, reconciliación de upgrades ni resolución automática de licencias externas. Exportar/publicar la variante sigue usando el gestor de paquetes habitual y requiere decidir licencia/versionado.

## Plataformas

Ver `../platforms/README.md`. React Native puede reutilizar lógica TypeScript, pero no los elementos HTML de los renderers web. Electron puede reutilizar vistas web, con proceso main/preload separado. SwiftUI usa modelos observables y vistas Swift; Android nativo usa un modelo Kotlin y su presentación. Cada plataforma necesita tests propios. Los folders planned no constituyen soporte implementado.

## Referencias que motivan el diseño

- [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore): integrar stores externos con snapshots estables y suscripciones.
- [Vue reactividad](https://vuejs.org/api/reactivity-core.html): conectar estado externo a su modelo reactivo.
- [shadcn registry](https://ui.shadcn.com/docs/registry): precedente de distribución de código modificable mediante registros.
- [SwiftUI model data](https://developer.apple.com/documentation/swiftui/model-data): modelos observables nativos.
- [React Native platform-specific code](https://reactnative.dev/docs/platform-specific-code): límites entre lógica común e implementaciones de plataforma.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): aislamiento de responsabilidades del host y renderer.
