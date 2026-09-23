import { createRTApp } from '../dist/index.js';
class Hello {
  init() {}
  greet(name: string): string { return `Hello, ${name}!`; }
}
const rtApp = createRTApp({ hello: { module: Hello } });
const result: string = rtApp('hello').greet('World');
rtApp().loadAll();
// @ts-expect-error Unknown registry names must be rejected.
rtApp('missing');
// @ts-expect-error The resolved instance retains its method signatures.
rtApp('hello').greet(123);
// @ts-expect-error Manager methods are not module methods.
rtApp('hello').loadAll();
void result;
