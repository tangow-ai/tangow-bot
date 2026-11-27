import { testSecretStore } from "./secret-store-conformance.test-support.js";
import { EncryptedSecretStore } from "./secrets.js";

testSecretStore(() => new EncryptedSecretStore("test-only-encryption-key"));
