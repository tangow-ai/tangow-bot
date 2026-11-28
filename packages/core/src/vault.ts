import type { BotSecretDestination, VaultList } from "@tangow/contracts";
import { previewSiteInitial } from "./link-preview.js";

export function filterVault(vault: VaultList, query: string): VaultList {
  const search = query.trim().toLowerCase();
  if (!search) return vault;

  const matches = (...fields: string[]) => fields.join(" ").toLowerCase().includes(search);

  return {
    mine: vault.mine.filter((item) => matches(item.name, new URL(item.origin).host)),
    shared: vault.shared.filter((item) =>
      matches(item.name, new URL(item.origin).host, item.ownerName),
    ),
  };
}

export function vaultInitial(item: BotSecretDestination): string {
  return previewSiteInitial(item.origin.replace("://api.", "://"));
}
