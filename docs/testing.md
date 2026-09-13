# Testing

What runs on every push (`.github/workflows/ci.yml`): typecheck, the unit and server suites with coverage floors, the build, the browser flows, a Docker build and smoke. What runs on every deploy of the suite: the gateway's post-deploy smoke (gateway-platform/docs/smoke.md), which crosses Envoy, ext_authz, the signed policy and a Canvas query as a real service account.

## The layers

- **Pure rules** (`test/dataHonesty`, `test/proposals`, `test/gatewayPolicy`, `test/metricTypes`, `test/joins`, `test/calendar`, `test/modeler`): the decisions that make a chart honest or a query safe, with their wording asserted verbatim. Error messages are part of the contract.
- **The compiler on real data** (`test/partialPeriods`, `test/corpus`, the lake halves of `metricTypes`, `calendar`, `modeler`): every metric in the sample model, including every computed one, across every dimension it can reach, on the sample lake. SQL shape tests say what the query looks like; these say the numbers agree with their parts.
- **The server** (`test/company`, `test/gateway`): a spawned team-mode server against a fake identity provider, and gateway-mode identity with signed policy headers. Roles, gates and refusals end to end.
- **The browser** (`e2e/`): the flows a person sees.

## Coverage floors

`vite.config.ts` sets per-file floors on the files where a regression is a leak or a wrong number: the compiler, the security modules, proposal validation, extend and drift, the honesty rules, the extension merge. CI runs `npm run test:coverage`; a change that drops one of these below its floor fails the build and says which file. Raise a floor when you raise coverage; never lower one to make a build pass.

`src/security/auth.ts` sits at 70% because its OIDC flows run in the spawned server of the company suite, which the coverage tool cannot see; the gateway-mode paths are covered directly.

## Known debts

- The company suite shares one server across cases and cases depend on order (one re-provisions the registry). Each case should set up its own source. Until then, add new cases at the end and use the source the case before left ready.
- Two suites read the clock: the browser preset tests (correctly: presets are relative to today) and the data-honesty rules in the running app. The sample lake ends on 2026-08-31, so as the calendar moves, weekly sample charts go from *partial* to *stale* findings; that is the honest answer, not a flake, but a demo should know it.
- The CLI's mock re-implements server rules by hand (policy merging, proposal validation); the two can drift. The admin surface should be run against the real control API in CI.
