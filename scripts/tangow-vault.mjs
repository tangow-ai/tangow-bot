import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const composeDir = fileURLToPath(new URL("../infra/compose/", import.meta.url));
const directory = join(composeDir, "openbao-private");
const names = ["unseal.key", "role-id", "secret-id"];
const directoryInfo = lstatSync(directory, { throwIfNoEntry: false });
if (directoryInfo && !directoryInfo.isDirectory()) {
  throw new Error("The vault credential path must be a directory.");
}

const files = names.map((name) => lstatSync(join(directory, name), { throwIfNoEntry: false }));
if (files.some(Boolean)) {
  if (!files.every((file) => file?.isFile())) {
    throw new Error("Vault files are missing or invalid. Restore all three original vault files.");
  }
  for (const name of names) {
    const value = readFileSync(join(directory, name));
    if (
      !(name === "unseal.key" && value.length === 32) &&
      !/^[a-f0-9]{64}$/.test(value.toString())
    ) {
      throw new Error(`Invalid vault file: ${name}. Restore all three original vault files.`);
    }
  }
  chmodSync(directory, 0o700);
} else {
  mkdirSync(composeDir, { recursive: true });
  const owner = lstatSync(composeDir);
  const staging = mkdtempSync(join(composeDir, ".env.tangow-vault-"));
  try {
    for (const name of names) {
      const filename = join(staging, name);
      const bytes = randomBytes(32);
      writeFileSync(filename, name === "unseal.key" ? bytes : bytes.toString("hex"), {
        mode: 0o400,
      });
      chmodSync(filename, 0o444);
      if (process.getuid?.() === 0) chownSync(filename, owner.uid, owner.gid);
    }
    chmodSync(staging, 0o700);
    if (process.getuid?.() === 0) chownSync(staging, owner.uid, owner.gid);
    renameSync(staging, directory);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
