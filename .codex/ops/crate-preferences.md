# Crate Explicit Preference Policy

## Purpose

Capture only explicit Bryant, Jenna, or joint workflow preferences so the source-of-truth Codex task can be consistent without treating inference or casual corrections as durable authority.

## Required Record

Every reusable preference must include:

- owner: Bryant, Jenna, or Bryant and Jenna
- scope and domain
- exact sanitized preference statement
- actor-bound source type, opaque source reference, and source revision
- confirmation date, review date, and expiry
- closed canonical subject, guidance effect, and supersession link
- active, superseded, or expired status
- privacy status

Active preferences require repo-contained reviewed decision records whose content hash, declared decision owner, preference subject, and exact sanitized preference statement match the source record. Joint preferences require distinct current Bryant and Jenna decision sources. Conflicting, ambiguous, stale, or expired preferences route to Bryant and Jenna for a decision.

## Boundaries

- Record explicit statements only. Do not infer personality, protected traits, relationships, health, finances, or private-client context.
- Preferences are advisory or default guidance only. They do not authorize code, communication, scheduling, money, legal, merge, release, deploy, remote mutation, or credential access.
- The decision log, current prompt, approved taskflow, and standing orders remain the authority sources.
- Live preference ledgers are private and uncommitted. Committed examples must be synthetic and sanitized.

Use the Crate Ops `crate-preference-ledger` skill and its versioned schema/validator.
