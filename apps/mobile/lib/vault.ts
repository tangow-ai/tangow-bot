import type { SpaceMembers, VaultItem, VaultList } from "@tangow/contracts";
import type { MobileSpaceNavigation } from "./api";
import { rpc } from "./api";
import { readViewer } from "./bot-page";
import { t } from "./i18n";

export type VaultScreen = {
  vault: VaultList;
  space: { id: string; name: string };
  people: SpaceMembers["members"];
};

/** The active space and its other members, the people a key can be shared with. */
export async function readSpacePeople(): Promise<Omit<VaultScreen, "vault">> {
  const [navigation, me] = await Promise.all([
    rpc<MobileSpaceNavigation>("spaces/list"),
    readViewer(),
  ]);
  const space = { id: navigation.current.id, name: navigation.current.name };
  const view = await rpc<SpaceMembers>("spaces/members", { spaceId: space.id });
  return { space, people: view.members.filter((member) => member.userId !== me.userId) };
}

/** The person's keys, the keys shared with them, and the other members a key can be shared with. */
export async function readVaultScreen(): Promise<VaultScreen> {
  const [vault, others] = await Promise.all([rpc<VaultList>("vault/list"), readSpacePeople()]);
  return { vault, ...others };
}

/** "Everyone", or the names of the people a key is shared with; empty when it is private. */
export function sharedWithLabel(item: VaultItem, people: SpaceMembers["members"]): string {
  if (item.space) return t("Everyone");
  return people
    .filter((member) => item.userIds.includes(member.userId))
    .map((member) => member.name)
    .join(", ");
}
