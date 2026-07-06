# Contributing

Thanks for your interest in improving the Kagura Memory TypeScript SDK!

## Development setup

Requires Node.js >= 18 (native `fetch`).

```bash
npm install
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsup → dist/ (ESM + CJS + d.ts)
```

## Before opening a pull request

Please make sure the full verification gate is green:

```bash
npm run typecheck && npm test && npm run build
```

- **Tests are required.** Every exported function should have at least one
  test. We use vitest with a stubbed `fetch` (each client accepts a `fetch`
  option) — no network calls in the suite.
- **TypeScript strict** must pass with no errors.
- **Zero runtime dependencies** is a design goal. Please don't add runtime
  `dependencies` without discussing it in an issue first.

## Conventions

- Public API mirrors the Python SDK's client and method names, camelCased
  per TS idiom (`remember`, `recall`, `listContexts`, …). Option keys are
  camelCase and converted to snake_case wire keys internally.
- Keep the published type surface self-contained — avoid forcing consumers
  onto newer `lib` targets (see the design doc for the rationale).
- See [`docs/design/2026-07-05-typescript-port-design.md`](docs/design/2026-07-05-typescript-port-design.md)
  for scope and architecture decisions.

## Reporting bugs / requesting features

Open an issue at
<https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues>.
For security issues, please follow [SECURITY.md](SECURITY.md) instead.

## License

By contributing, you agree that your contributions will be licensed under
the [MIT License](LICENSE).
