# Security Policy

## Supported versions

The latest tagged release is the only one that gets fixes. Self-hosted deployments have to update themselves.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Use GitHub's [private vulnerability reporting](https://github.com/Booyaka101/studio-os/security/advisories/new) instead. Expect a first response within a week.

Please include what you found, how to reproduce it, and what an attacker gets out of it.

## What this touches

Self-hosted. It holds your customers' booking data and talks to your own payment account. Nothing is sent to us.

- **It holds your customers' data**: names, contact details, bookings and pack balances, in your own database. Nothing is sent to us, ever.
- **Payments run through Stripe Checkout on your own account.** Card details are entered on Stripe's hosted page and never reach this application. Keep your webhook signing secret secret; an attacker holding it can forge payment events.
- **Sessions, CSRF and rate limiting** are in scope, and so is anything that lets one studio read another's data.

## Scope

In scope: anything that leaks a credential, reads data belonging to someone else, or lets untrusted input reach code execution.

Out of scope: findings that require an attacker to already control the machine it runs on.
