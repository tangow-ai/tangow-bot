import type { SecretStore } from "@tangow/adapter-kit";
import { describe, expect, it } from "vitest";

export function testSecretStore(createStore: () => SecretStore | Promise<SecretStore>) {
  const recordId = "record-1";
  const smallValue = "fixture credential";

  describe("SecretStore conformance", () => {
    it.each([
      { label: "ordinary value", length: smallValue.length },
      { label: "16,384-character value", length: 16_384 },
    ])("seals and opens a $label without exposing plaintext", async ({ length }) => {
      const store = await createStore();
      const plaintext = smallValue.padEnd(length, "x");
      const sealed = await store.seal(plaintext, recordId);
      expect(sealed.includes(plaintext)).toBe(false);
      const opened = await store.open(sealed, recordId);
      expect(opened.ok && opened.plaintext === plaintext).toBe(true);
    });

    it("rejects a sealed value under a different record ID", async () => {
      const store = await createStore();
      const sealed = await store.seal(smallValue, recordId);
      const opened = await store.open(sealed, "record-2");
      expect(opened.ok ? "opened" : opened.reason).toBe("cannot_open");
    });

    it("rejects a tampered sealed value", async () => {
      const store = await createStore();
      const sealed = await store.seal(smallValue, recordId);
      const index = Math.floor(sealed.length / 2);
      const tampered =
        sealed.slice(0, index) + (sealed[index] === "A" ? "B" : "A") + sealed.slice(index + 1);
      const opened = await store.open(tampered, recordId);
      expect(opened.ok ? "opened" : opened.reason).toBe("cannot_open");
    });
  });
}
