"""Swap the factory/import at the composition root; consumers depend on Protocol."""
from dataclasses import dataclass
from functools import partial
from typing import Protocol
from rt_app_core import Singleton

class Greeter(Protocol):
    def hello(self) -> str: ...
    def close(self) -> None: ...

class EnglishGreeter:
    def __init__(self, *, name: str = "World"):
        self.name = name
    def hello(self) -> str:
        return f"Hello, {self.name}"
    def close(self) -> None:
        pass

class SpanishGreeter(EnglishGreeter):
    def hello(self) -> str:
        return f"Hola, {self.name}"

@dataclass
class App:
    greeting: Singleton[Greeter]

def create_app(name: str) -> App:
    return App(Singleton(partial(EnglishGreeter, name=name), close=lambda g: g.close()))

if __name__ == "__main__":
    app = create_app("RT-App")
    with app.greeting:
        print(app.greeting.get().hello())
