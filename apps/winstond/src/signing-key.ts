/**
 * The public half of the KMS key that signs VM binaries
 * (alias/winston/vm-binary-signing in winston-prod: ECC P-256, ECDSA_SHA_256).
 * winstond verifies every downloaded binary against it, offline. Public keys
 * aren't secret. If the key ever changes, ship a winstond carrying the new one,
 * signed with the old one.
 */
export const signingPublicKey = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdmitDQ2XklAqZag138hvm/5+lSKZ
gVm59go3UtUCLMmj8r5UygQx3yZws0xLurpSXG3huwMjT/IbQOgP/T+9Kw==
-----END PUBLIC KEY-----`;
