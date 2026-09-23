# Starter conventions

Read CLAUDE.md for project layout and runtime constraints, and rt-app/AGENTS.md before changing the framework.

- Separate methods and top-level functions with a blank line. Group imports, types, configuration, lifecycle and public operations into readable sections.
- Give exported functions, classes and configuration contracts short purpose-oriented documentation. Comment non-obvious constraints and side effects, not every statement.
- Keep settings explicit, typed and grouped by responsibility. Never embed credentials in examples, source, templates or logs.
- Keep business behavior in modules; apps are entry points. Reuse existing authorization, validation, audit, concurrency and idempotency rules across HTTP, CLI and MCP.
- Each published action must have a stable namespaced name, short description and parameter example. Publication is explicit, discovery is automatic.
- Tests belong to their owning module/app. Build and run affected tests before delivery.
- Preserve compact forms: modest field spacing, semibold labels, regular values, muted descriptions, accessible keyboard controls.
