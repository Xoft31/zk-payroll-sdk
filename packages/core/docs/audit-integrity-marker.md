# Audit Export Integrity Marker Guide

The `AuditIntegrityMarkerManager` provides cryptographic integrity verification for audit log exports in the ZK Payroll SDK.

## Features
- **Tamper-Evident Hashing:** Computes deterministic SHA-256 or HMAC-SHA256 signatures over canonical export payloads.
- **Verification API:** Easily verify whether exported audit records have been altered.
