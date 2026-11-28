import { Trans, useLingui } from "@lingui/react/macro";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@tangow/ui-web";
import { Pencil, Trash2 } from "lucide-react";
import { lazy, Suspense } from "react";
import type { NavigateFunction } from "react-router-dom";
import { rpc, selectedSpaceId, selectSpace } from "../../lib/rpc";
import type { BotAction } from "./bot-commands";
import { CommandPalette } from "./command-palette";
import {
  ClearConversationDialog,
  DeleteBotDialog,
  DeleteItemDialog,
  LeaveGroupDialog,
  NewBotSectionDialog,
  NewSpaceDialog,
  PickerInfoDialog,
  RenameBotSectionDialog,
} from "./dialogs";
import type { SidebarGroup } from "./layout";
import { botPageFor, threadJumpLocation } from "./layout";
import type { Panels } from "./use-panels";
import type { Roster } from "./use-roster";
import type { ShellOverlayState } from "./use-shell-overlays";
import type { ThreadStore } from "./use-thread-store";
import type { ThreadViewState } from "./use-thread-view";
import type { Voice } from "./use-voice";

const BotContextMenu = lazy(() =>
  import("../BotContextMenu").then((module) => ({ default: module.BotContextMenu })),
);
const ShareBotDialog = lazy(() =>
  import("../ShareBotDialog").then((module) => ({ default: module.ShareBotDialog })),
);
const MessagingSettingsOverlay = lazy(() =>
  import("../MessagingSettingsOverlay").then((module) => ({
    default: module.MessagingSettingsOverlay,
  })),
);
const SettingsOverlay = lazy(() =>
  import("../SettingsOverlay").then((module) => ({ default: module.SettingsOverlay })),
);
const PeerMessagesOverlay = lazy(() =>
  import("../PeerMessagesOverlay").then((module) => ({ default: module.PeerMessagesOverlay })),
);
const CustomizeOverlay = lazy(() =>
  import("../CustomizeOverlay").then((module) => ({ default: module.CustomizeOverlay })),
);

/** Everything that opens over the shell: context menus, confirmations, palette and overlays. */
export function ShellOverlays({
  overlays,
  roster,
  store,
  panels,
  thread,
  voice,
  navigate,
  runBotAction,
  refreshAgentSkills,
  openSpaceChat,
  sidebarGroups,
  userName,
  initials,
  userImage,
  email,
}: {
  overlays: ShellOverlayState;
  roster: Roster;
  store: ThreadStore;
  panels: Panels;
  thread: ThreadViewState;
  voice: Voice;
  navigate: NavigateFunction;
  runBotAction: (botId: string, action: BotAction) => void;
  refreshAgentSkills: () => void;
  openSpaceChat: (spaceId: string, path: string) => void;
  sidebarGroups: SidebarGroup[];
  userName: string;
  initials: string;
  userImage: string | null;
  email: string | undefined;
}) {
  const { t } = useLingui();
  const { bots, groups, setGroups, botSections, spaces, bootstrapMe, refreshBots } = roster;
  const { active, activeGroup } = roster;
  const { setPanel, showBotPage } = panels;
  const { botMenu, setBotMenu, closeBotMenu, spaceMenu, setSpaceMenu, closeSpaceMenu } = overlays;
  const { sectionMenu, setSectionMenu, closeSectionMenu } = overlays;
  const { deleteTarget, setDeleteTarget, deleteGroupTarget, setDeleteGroupTarget } = overlays;
  const { deleteSpaceTarget, setDeleteSpaceTarget, clearTarget, setClearTarget } = overlays;
  const { leaveGroupTarget, setLeaveGroupTarget } = overlays;
  const { shareTarget, setShareTarget } = overlays;
  const { newSectionTarget, setNewSectionTarget } = overlays;
  const { renameSectionTarget, setRenameSectionTarget } = overlays;
  const { peerConversation, setPeerConversation } = overlays;
  const contextBot =
    botMenu?.kind === "bot" ? bots.find((bot) => bot.id === botMenu.id) : undefined;
  const contextGroup =
    botMenu?.kind === "group" ? groups.find((group) => group.id === botMenu.id) : undefined;
  const contextChat = contextBot ?? contextGroup;
  // Only a group's creator manages it; everyone else can leave it.
  const manages = contextGroup?.canManage ?? true;

  return (
    <>
      <Suspense fallback={null}>
        {contextChat && botMenu ? (
          <BotContextMenu
            bot={contextChat}
            owned={contextBot?.isOwner ?? true}
            position={botMenu.position}
            onClose={closeBotMenu}
            sections={botSections}
            onTogglePinned={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.update({ botId: contextBot.id, pinned: !contextBot.pinned })
                : rpc.groups.update({
                    groupId: contextGroup!.id,
                    pinned: !contextGroup!.pinned,
                  });
              void request.then(() => refreshBots());
            }}
            onToggleUnread={() => {
              const unread = !contextChat.unread;
              setBotMenu(null);
              if (contextBot) {
                const request = unread
                  ? roster.markBotUnread(contextBot.id)
                  : roster.markBotRead(contextBot.id);
                void request.catch(() => undefined);
              } else {
                const request = unread
                  ? rpc.threads.markUnread({ groupId: contextGroup!.id })
                  : rpc.threads.markRead({ groupId: contextGroup!.id });
                void request
                  .then(() =>
                    setGroups((current) =>
                      current.map((group) =>
                        group.id === contextGroup!.id ? { ...group, unread } : group,
                      ),
                    ),
                  )
                  .catch(() => undefined);
              }
            }}
            onMoveToSection={(sectionId) => {
              setBotMenu(null);
              if (sectionId === contextChat.sectionId) return;
              const request = contextBot
                ? rpc.bots.update({ botId: contextBot.id, sectionId })
                : rpc.groups.update({ groupId: contextGroup!.id, sectionId });
              void request.then(() => refreshBots());
            }}
            onCreateSection={() => {
              setNewSectionTarget(
                contextBot
                  ? { kind: "bot", chat: contextBot }
                  : { kind: "group", chat: contextGroup! },
              );
              setBotMenu(null);
            }}
            onRenameSection={(sectionId) => {
              const section = botSections.find((item) => item.id === sectionId);
              const spaceId = bootstrapMe?.spaceId;
              if (section && spaceId) setRenameSectionTarget({ section, spaceId });
              setBotMenu(null);
            }}
            editLabel={contextBot ? t`Bot settings` : t`Edit Profile`}
            onEdit={
              manages
                ? () => {
                    setBotMenu(null);
                    if (contextBot) {
                      navigate(`/app/${contextBot.id}`);
                      showBotPage(botPageFor("menu", contextBot));
                      return;
                    }
                    navigate(`/app/g/${contextGroup!.id}`);
                    setPanel("group-settings");
                  }
                : undefined
            }
            onShare={
              contextBot
                ? () => {
                    setBotMenu(null);
                    runBotAction(contextBot.id, "share");
                  }
                : undefined
            }
            onDuplicate={
              manages
                ? () => {
                    setBotMenu(null);
                    if (contextBot) {
                      runBotAction(contextBot.id, "duplicate");
                      return;
                    }
                    void rpc.groups.duplicate({ groupId: contextGroup!.id }).then(async (chat) => {
                      await refreshBots();
                      navigate(`/app/g/${chat.id}`);
                    });
                  }
                : undefined
            }
            onClear={
              // A group of several people keeps its history: no one clears it alone.
              (contextGroup?.people.length ?? 0) > 1
                ? undefined
                : () => {
                    setBotMenu(null);
                    if (contextBot) runBotAction(contextBot.id, "clear");
                    else setClearTarget({ kind: "group", chat: contextGroup! });
                  }
            }
            onArchive={
              manages
                ? () => {
                    setBotMenu(null);
                    if (contextBot) {
                      runBotAction(contextBot.id, "archive");
                      return;
                    }
                    void rpc.groups
                      .archive({ groupId: contextGroup!.id })
                      .then(() => refreshBots(true));
                  }
                : undefined
            }
            onDelete={
              manages
                ? () => {
                    setBotMenu(null);
                    if (contextBot) runBotAction(contextBot.id, "delete");
                    else setDeleteGroupTarget(contextGroup!);
                  }
                : undefined
            }
            onLeave={
              manages
                ? undefined
                : () => {
                    setBotMenu(null);
                    setLeaveGroupTarget(contextGroup!);
                  }
            }
          />
        ) : null}

        {shareTarget && bootstrapMe ? (
          <ShareBotDialog
            bot={shareTarget}
            spaceName={spaces.find((space) => space.id === shareTarget.spaceId)?.name ?? ""}
            userId={bootstrapMe.userId}
            onClose={() => setShareTarget(null)}
          />
        ) : null}

        {spaceMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) closeSpaceMenu();
            }}
          >
            {/* Invisible anchor at the pointer position, mirroring the bot menu. */}
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="fixed size-0 p-0 opacity-0"
                  style={{ left: spaceMenu.position.x, top: spaceMenu.position.y }}
                />
              }
            />
            <DropdownMenuContent
              aria-label={t`Actions for space`}
              align="start"
              sideOffset={0}
              className="w-[220px]"
            >
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  const target = spaces.find((space) => space.id === spaceMenu.id);
                  if (target) setDeleteSpaceTarget(target);
                  setSpaceMenu(null);
                }}
              >
                <Trash2 />
                {t`Delete space`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {deleteTarget ? (
          <DeleteBotDialog
            bot={deleteTarget}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={async (deleteMemories) => {
              await rpc.bots.remove({ botId: deleteTarget.id, deleteMemories });
              setDeleteTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {deleteGroupTarget ? (
          <DeleteItemDialog
            item={deleteGroupTarget}
            noun="group"
            onCancel={() => setDeleteGroupTarget(null)}
            onConfirm={async () => {
              await rpc.groups.remove({ groupId: deleteGroupTarget.id });
              setDeleteGroupTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {leaveGroupTarget ? (
          <LeaveGroupDialog
            group={leaveGroupTarget}
            onCancel={() => setLeaveGroupTarget(null)}
            onConfirm={async () => {
              await rpc.groups.leave({ groupId: leaveGroupTarget.id });
              setLeaveGroupTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {deleteSpaceTarget ? (
          <DeleteItemDialog
            item={deleteSpaceTarget}
            noun="space"
            description={
              <Trans>Only empty spaces can be deleted. Delete its bots and groups first.</Trans>
            }
            onCancel={() => setDeleteSpaceTarget(null)}
            onConfirm={async () => {
              const targetId = deleteSpaceTarget.id;
              const result = await rpc.spaces.remove({ spaceId: targetId });
              setDeleteSpaceTarget(null);
              setPanel(null);
              const effectiveSpaceId = selectedSpaceId() ?? bootstrapMe?.spaceId;
              if (effectiveSpaceId === targetId) {
                // The open space is gone, so reload into the one the server picked.
                if (selectSpace(result.activeSpaceId)) {
                  window.location.assign("/app");
                  return;
                }
              }
              await refreshBots(true);
            }}
          />
        ) : null}

        {newSectionTarget ? (
          <NewBotSectionDialog
            bot={newSectionTarget.chat}
            onCancel={() => setNewSectionTarget(null)}
            onConfirm={async (name) => {
              await rpc.botSections.create(
                newSectionTarget.kind === "bot"
                  ? { botId: newSectionTarget.chat.id, name }
                  : { groupId: newSectionTarget.chat.id, name },
              );
              setNewSectionTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {renameSectionTarget ? (
          <RenameBotSectionDialog
            section={renameSectionTarget.section}
            onCancel={() => setRenameSectionTarget(null)}
            onConfirm={async (name) => {
              await rpc.botSections.update(
                {
                  sectionId: renameSectionTarget.section.id,
                  name,
                },
                { context: { spaceId: renameSectionTarget.spaceId } },
              );
              setRenameSectionTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {sectionMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) closeSectionMenu();
            }}
          >
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="fixed size-0 p-0 opacity-0"
                  style={{ left: sectionMenu.position.x, top: sectionMenu.position.y }}
                />
              }
            />
            <DropdownMenuContent
              aria-label={t`Actions for ${sectionMenu.section.name}`}
              align="start"
              sideOffset={0}
              className="w-[220px]"
            >
              <DropdownMenuItem
                onClick={() => {
                  setRenameSectionTarget({
                    section: sectionMenu.section,
                    spaceId: sectionMenu.spaceId,
                  });
                  setSectionMenu(null);
                }}
              >
                <Pencil />
                {t`Rename section`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <CommandPalette
          open={overlays.commandPaletteOpen}
          onOpenChange={overlays.setCommandPaletteOpen}
          groups={sidebarGroups}
          userId={bootstrapMe?.userId}
          initials={initials}
          userImage={userImage}
          onSelectChat={(item) =>
            openSpaceChat(
              item.chat.spaceId,
              item.kind === "bot" ? `/app/${item.chat.id}` : `/app/g/${item.chat.id}`,
            )
          }
          onSelectSettings={overlays.openSettings}
          onSelectHit={(hit) => navigate(threadJumpLocation(hit))}
        />

        {overlays.newSpaceOpen ? (
          <NewSpaceDialog
            onCancel={() => overlays.setNewSpaceOpen(false)}
            onConfirm={async (name) => {
              const space = await rpc.spaces.create({ name });
              if (!selectSpace(space.id)) {
                overlays.setNewSpaceOpen(false);
                await refreshBots();
                return;
              }
              window.location.assign("/onboarding");
            }}
          />
        ) : null}

        {overlays.pickerInfoTopic ? (
          <PickerInfoDialog
            topic={overlays.pickerInfoTopic}
            onClose={() => overlays.setPickerInfoTopic(null)}
          />
        ) : null}

        {clearTarget ? (
          <ClearConversationDialog
            bot={clearTarget.chat}
            onCancel={() => setClearTarget(null)}
            onConfirm={async () => {
              await rpc.threads.clear(
                clearTarget.kind === "bot"
                  ? { botId: clearTarget.chat.id }
                  : { groupId: clearTarget.chat.id },
              );
              if (
                (clearTarget.kind === "bot" && active?.id === clearTarget.chat.id) ||
                (clearTarget.kind === "group" && activeGroup?.id === clearTarget.chat.id)
              ) {
                store.leaveJumpWindow();
                store.historyEpoch.current += 1;
                store.updateSnapshot((current) => (current ? { ...current, run: null } : current));
              }
              setClearTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {overlays.customizeOpen ? (
          <CustomizeOverlay
            activeBotId={roster.activeBotId.current}
            onClose={() => overlays.setCustomizeOpen(false)}
            initialSection={overlays.customizeSection}
            onSkillsChanged={refreshAgentSkills}
          />
        ) : null}
        {overlays.messagingSettingsOpen ? (
          <MessagingSettingsOverlay onClose={() => overlays.setMessagingSettingsOpen(false)} />
        ) : null}
      </Suspense>

      <Suspense fallback={null}>
        {overlays.settingsOpen ? (
          <SettingsOverlay
            name={userName}
            initials={initials}
            image={userImage}
            userId={bootstrapMe?.userId}
            email={email}
            initialSection={overlays.settingsSection}
            isDeploymentOwner={bootstrapMe?.isDeploymentOwner === true}
            messagingEnabled={overlays.messagingSurfaceEnabled}
            onOpenMessaging={() => {
              overlays.setSettingsOpen(false);
              overlays.setMessagingSettingsOpen(true);
            }}
            memoryConfig={overlays.memoryProviderConfig}
            onMemoryConfigChange={overlays.changeMemoryConfig}
            spaces={spaces}
            currentSpaceId={bootstrapMe?.spaceId}
            onSwitchSpace={(spaceId) => openSpaceChat(spaceId, "/app")}
            onSpaceRenamed={() => refreshBots()}
            onVoiceStatusMaybeChanged={voice.refreshVoiceStatus}
            onClose={() => {
              overlays.setSettingsOpen(false);
              overlays.setSettingsSection(null);
            }}
          />
        ) : null}
        {peerConversation && active ? (
          <PeerMessagesOverlay
            botId={active.id}
            botName={active.name}
            botAvatarCharacter={active.avatarCharacter}
            peerBotId={peerConversation.peerBotId}
            peerBotName={peerConversation.peerBotName}
            peerBotAvatarCharacter={
              thread.resolveTranscriptBot(peerConversation.peerBotId)?.avatarCharacter
            }
            onClose={() => setPeerConversation(null)}
          />
        ) : null}
      </Suspense>
    </>
  );
}
