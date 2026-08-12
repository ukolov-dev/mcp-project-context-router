---
kind: policy
modules: [router, tests]
routing: core
required: true
triggers: []
last_verified: '2026-07-10'
verify_with: [package_build, package_tests, package_check]
---
# Router testing

Run the smallest focused Vitest target while iterating. Before handoff, run the full build and test suite. Packaging changes also require `npm run package:check` plus a tarball installation smoke test in a temporary consumer repository.

Tests must use temporary repositories and generic project configuration. Do not depend on PPM source paths, records, branding, or a developer-specific absolute path.
