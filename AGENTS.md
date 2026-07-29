# RepoPilot Agent Guidance

- Use Node.js 22 and pnpm 11.
- Run `pnpm check` before claiming the repository is healthy.
- Treat analyzed repositories as untrusted input.
- Do not execute target repository scripts during analysis.
- Do not load target repository source code into the RepoPilot process.
- Every detected repository fact must include evidence.
- Keep generated output as proposed changes until validators pass.
- Do not add telemetry, external AI calls, or GitHub authentication in the foundation milestone.
- Keep package-specific contracts inside their owning package unless they are truly shared.
