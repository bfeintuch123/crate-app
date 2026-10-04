# Crate private cache-policy backport 0.1.0

This is substantively modified Crate-maintained software, derived from http-cache-semantics 4.2.0. It is not an official upstream release or an upstream version claim. The independent identity is crate-http-cache-semantics-backport@0.1.0. Runtime source remains the reviewed security backport; no runtime dependencies or lifecycle hooks are added.

Upstream repository: git+https://github.com/kornelski/http-cache-semantics.git
Upstream archive: https://registry.npmjs.org/http-cache-semantics/-/http-cache-semantics-4.2.0.tgz
Authenticated upstream archive integrity: sha512-dTxcvPXqPvXBQpq5dUr6mEMJX4oIEFv6bwom3FDwKRDsuIjjJGANqhBuoAn9c1RQJIdAKav33ED65E2ys+87QQ==
Upstream archive SHA256: f57454db8ab2d06a4baabbfb7c70ad4181a00b7ee0efebcdffa9ba313bd80eb7
Upstream 4.2.0 index.js SHA256: 01b7d66c854b2fe53ac05c98feb6e0d64722ab8898a778e2d2426a8b468d178f
Reviewed modified index.js SHA256: 91395fae0cfe22fb18f5c905f484856ac7ee39f737a9aa6c351c63bc3ca8abcf
Original license SHA256: ab868ad5a2ef5068560d9cd3b2180ec63c140bb4c5cae1ba779d300a0ac74fa3
Original author: Kornel Lesiński <npms2@geekhood.net> (https://kornel.ski/)
Original BSD copyright and license text are retained verbatim in LICENSE.

Patch ancestry: upstream PR58 base f01112e954b83cfa8765b633ba880e5e980aa54c, head 14a8c2ad51740dc39bf3e8f1a11c845a5003f217; supplement PR1 head 101a9e9a5b9aba5750a74b8f659c5646e90a962f. These were open/unmerged at the retained snapshot. Crate's complete reviewed baseline-to-candidate patch is retained as reviewed-source.diff beside this artifact; SHA256 9d8db38c79a52c1d65258cc784418e2f3cfea5aec5803eb4b811354878b1321e. This is not a claim that upstream has approved the Crate candidate.

Source review evidence: writer receipt SHA256 19327135c9dd3f47800d08421a190dba760166470255676ca957f25e5b836759; cookie supplement SHA256 398420492a1ce6fa60fcea9b5d023889eacb62f0b80a85efc7ca766c1d6aa1db. Independent source correctness/security PASS and actual Fable source approval/testing (177 candidate checks plus 7 baseline checks) are source-level evidence, not approval of this newly identified artifact or future integration.

Tracked upstream advisory: GHSA-ch52-4w7c-c8xp. Original-identity patched archive installation/lifecycle passed but unchanged high audit failed. This independent name/version changes automatic advisory matching. Audit green alone is insufficient; no suppression or audit threshold change is permitted.

Maintenance disposition: isolated validation only. Before PR integration, Chief/security must assign a named maintenance owner and explicitly accept compensating upstream advisory monitoring and applicability review. That owner must track http-cache-semantics advisories and source changes, retain provenance/hash/consumer regressions, review each relevant advisory, and retire the fork when a genuinely fixed upstream artifact passes the same source/consumer/install/audit/review/CI gates. Ownership acceptance is PENDING, not fabricated here. This package is private and unpublished.

Known limits: inherited cookie-free cold/unexpected 304 status normalization in cacheable-request can affect conditional-download correctness. Shared-cookie replay protections do not prove general HTTP correctness. Required installed-consumer failure blocks acceptance; no transport rewrite is authorized. Persistent historically erased metadata cannot be reconstructed. Retained request metadata relies on module/header-object identity. Actual Crate cache options/shared-principal exposure, full HTTP/native/build behavior, artifact-specific Fable, integration reviews and final-head protected CI remain separate gates.
