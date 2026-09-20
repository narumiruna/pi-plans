# pi-plans

A Pi package for creating, opening, and revising durable plan documents.

## Install

```sh
pi install npm:@narumitw/pi-plans
```

To use a local checkout instead:

```sh
pi install /absolute/path/to/pi-plans
```

Reload Pi after installation, then run `/plans`.

## Features

- `/plans` provides an interactive TUI for drafting, editing, and improving plans.
- `plan_document` lets Pi list, read, create, replace, and exactly edit plans.
- Replacements detect stale content to prevent lost updates.
- Writes use Pi's per-file mutation queue and atomic rename.
- Tool output is limited to 50 KB or 2,000 lines.

Plans are stored in `~/.pi/agent/plans/`. Only Markdown files directly inside that directory are managed.
The `/plans` command requires Pi's interactive TUI; the `plan_document` tool works in every mode.

## Development

```sh
npm install
npm run ci
```

The CI command runs Biome, Vitest, and the TypeScript build. Husky runs the formatter and linter before each commit.
