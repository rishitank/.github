# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on the affected repository (Security tab → Report a vulnerability). If that is
not enabled, email the address on the account profile.

Please include what the issue is, how to reproduce it, and what an attacker
gains. A proof of concept helps more than a description.

Expect an acknowledgement within 5 working days.

## Supported versions

These are actively developed projects without long-term support branches. Fixes
land on the default branch and are released from there. Only the latest release
is supported.

## What is scanned automatically

Every repository running the shared `security.yml` workflow is checked on push,
pull request and weekly for:

- vulnerable dependencies (osv-scanner, across npm / PyPI / crates / Go)
- committed secrets, including in git history (gitleaks)
- ecosystem advisories (npm audit, pip-audit, cargo-audit)

Note that CodeQL is not part of this. Static analysis on private repositories
requires GitHub Code Security, which is not enabled on this account. Public
repositories run CodeQL separately.
