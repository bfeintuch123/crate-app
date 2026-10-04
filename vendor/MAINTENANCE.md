# Private cache-policy fork maintenance

This record applies to `crate-http-cache-semantics-backport@0.1.0`, derived from upstream `http-cache-semantics@4.2.0`. The fork is repository-contained and private; it is not an official upstream release. Original author, copyright and BSD license remain in the source and archive.

Accountable owner: **Bryant Feintuch**. Upstream advisory coordination: **Mack**, before Crate releases. Bryant approved this ownership and the conditional integration on October 4, 2026, with independent Astra/medium artifact approval replacing Fable for this artifact gate only. Merge still requires all current final-head checks. No npm publication is authorized or needed.

The fork's independent package name/version changes automatic upstream advisory matching. `npm audit --audit-level=high` and the lifecycle/security controls remain unchanged. Audit green does not establish source-security closure or discharge upstream monitoring.

Before a release, Mack coordinates checking upstream http-cache-semantics advisories and source/release changes, records their applicability to this maintained fork, and escalates any relevant unresolved security or compatibility finding to Bryant. Track `GHSA-ch52-4w7c-c8xp` and later upstream advisories. Retain the reviewed source, original license, authenticated ancestry, complete patch, reproducible archive recipe, immutable artifact/lock integrity, installed-consumer security regressions and current independent reviews. Any applicable unresolved high-severity issue blocks release; do not suppress audit findings or lower thresholds.

Retirement trigger: a genuinely fixed upstream artifact passes the same source/consumer compatibility, installed-byte, frozen-install, audit, lifecycle, independent-review and exact-head CI gates. Then replace and retire this private fork through normal reviewed changes. No blind version bump or advisory-range-only acceptance.

Exact accepted validation candidate:

- Runtime SHA256: `91395fae0cfe22fb18f5c905f484856ac7ee39f737a9aa6c351c63bc3ca8abcf`.
- Archive SHA256: `2254db1cde2bda50f960d563f7c108558d5ad7933057f882c40eeacb0920d266`.
- Archive integrity: `sha512-jRzSy3ZvzUmLOhhAmz9hiiXxU7ATAYgmcJT4U7b7ANreMYqewFnj+q98ev6g9ZOVR0i+HZ9mdrCxElMLlZVO/Q==`.
- Portable lock SHA256 from isolated validation: `ad2b31187e40b06e841caba2d2c05d01d26723df0df3bb4803a709dd08ecc055`.

The archive's sealed PROVENANCE.md accurately records ownership as pending at artifact preparation. This subsequent owner-approved record resolves that disposition before integration, without changing the reviewed archive or runtime bytes. Independent artifact approval and final-head integration gates remain separate.

Patch storage: `reviewed-source.diff.gz` preserves the exact reviewed patch. Its decompressed SHA256 is `9d8db38c79a52c1d65258cc784418e2f3cfea5aec5803eb4b811354878b1321e`; gzip timestamp is zero. The compressed sidecar avoids treating required unified-diff context spaces as newly introduced source whitespace. The archive and its four readable source/manifest/license/provenance siblings are unchanged; this record resolves the historical uncompressed filename mentioned in provenance. No whitespace or security check is suppressed.

Known limits remain disclosed: inherited cookie-free cold/unexpected 304 normalization in cacheable-request; actual Crate cache activation/shared-principal exposure and general HTTP, persistent-cache, concurrent, native/download/build behavior are unproved. Focused synthetic regressions are not native or release acceptance. Any required consumer failure blocks acceptance.
