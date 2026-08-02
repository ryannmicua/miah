# Miah

> Miah is a resumable plan supervisor: it directs one approved plan at a time, start to finish. It hands every step to an implementation agent, runs it past an independent reviewer, and refuses to call a step done until you sign off. Each run is locked to an immutable plan snapshot, tracked in an append-only journal, and picks up exactly where it left off if your session dies. Like the wall-builder Nehemiah, it keeps the ledger, keeps the crews honest, and stays at it until the work is done — your session can crash, and Miah won't lose a step.

## Status

This repository is a fresh scaffold. The product vision is not yet written down.

## Getting started

Run an agent from this directory and follow `AGENTS.md`. The first pass interviews you to flesh out the product vision, writes `VISION.md`, and rewrites `AGENTS.md` for the phase the project is in.

## Layout

- `AGENTS.md` — phase-aware operating instructions; rewrites itself as the project advances
- `VISION.md` — product vision (created during the first agent pass, once you run it)
- `tmp/` — scratch space; committed empty, contents ignored
