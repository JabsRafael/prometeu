# ADR 0001 — Knowledge versioned in the repository

Date: 2026-09-03
Status: Accepted

## Context

The project grew with detailed code comments, a narrative README and specific
instructions in `CLAUDE.md`. Important decisions and invariants existed, but
finding them required knowing the right file beforehand. Another agent or person
could repeat an investigation, create an incompatible abstraction or change a
rule without noticing its reason.

Large instructions loaded in every session also compete with the task's context.
Keeping copies in each agent's specific format increases drift.

## Options considered

1. Keep only comments and the README.
2. Keep a wiki or external documents.
3. Use one large instruction file per tool.
4. Keep structured technical knowledge versioned next to the code, with short
   entry files for agents.

## Decision

The `docs/` directory is the technical source of truth. `ARCHITECTURE.md`
is the overall map, `README.md` presents the product and its
use, and `AGENTS.md` is a short index with invariants and essential
commands.

Tool-specific files must import or point to `AGENTS.md` and contain only the
real differences of that tool. Contracts, decisions, quality and operations
have their own areas in `docs/`.

Documentation goes through the same versioning and review as the code. A change
in behavior, contract or decision updates the corresponding documentation in the
same change.

The checked-out documentation describes the current system. Obsolete decisions
are removed after their remaining guarantees are consolidated; Git retains the
history. [ADR 0044](0044-current-documentation.md) defines this lifecycle.

## Consequences

Positive:

- humans and agents consult the same source;
- decisions gain history and an explicit status;
- the initial context stays small;
- documents can be verified by links, tests and CI;
- onboarding does not depend on the memory of whoever wrote the code.

Negative:

- every architectural change gains a small documentation maintenance cost;
- incorrect documents can give false confidence;
- links and compatibility with the code will need periodic review.

## Evidence

- `AGENTS.md` points to the documentation tree.
- `CLAUDE.md` imports the shared instructions.
- `docs/README.md` keeps the navigable index.
- contracts distinguish the current state from proposals not yet implemented.
