import type { Bot, BotSection, Group, Space, SpaceMemoryConfig } from "@tangow/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { rpc } from "../../lib/rpc";
import type { ContextMenuPosition } from "../BotContextMenu";
import type { CustomizeSection } from "../CustomizeOverlay";
import type { SettingsSection } from "../settings-sections";
import type { RunView } from "./bot-commands";
import { isCommandPaletteHotkey } from "./command-palette";

type ChatTarget = { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group };

/**
 * What opens over the shell: context menus, confirmations, the command palette
 * and the settings overlays, with the account data those overlays show.
 */
export function useShellOverlays(sessionUser: unknown, spaceId: string | undefined) {
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const [customizeSection, setCustomizeSection] = useState<CustomizeSection>();
  useEffect(() => {
    if (params.get("customize") !== "custom-apps") return;
    setCustomizeSection("custom-apps");
    setCustomizeOpen(true);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("customize");
        return next;
      },
      { replace: true },
    );
  }, [params, setParams]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  useEffect(() => {
    if (params.get("settings") !== "vault") return;
    setSettingsSection("vault");
    setSettingsOpen(true);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("settings");
        return next;
      },
      { replace: true },
    );
  }, [params, setParams]);
  const [messagingSettingsOpen, setMessagingSettingsOpen] = useState(false);
  const [messagingSurfaceEnabled, setMessagingSurfaceEnabled] = useState(false);
  const [messagingProviders, setMessagingProviders] = useState<string[]>([]);
  const [memoryProviderConfig, setMemoryProviderConfig] = useState<
    SpaceMemoryConfig | null | undefined
  >(undefined);
  const memoryProviderConfigRevision = useRef(0);
  const [peerConversation, setPeerConversation] = useState<{
    peerBotId: string;
    peerBotName: string;
  } | null>(null);
  const [runView, setRunView] = useState<RunView | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [pickerInfoTopic, setPickerInfoTopic] = useState<"group" | "space" | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [botMenu, setBotMenu] = useState<{
    kind: "bot" | "group";
    id: string;
    position: ContextMenuPosition;
  } | null>(null);
  // The context menu anchors to the pointer, so return focus to the row that opened it.
  const botMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (botMenu || !botMenuAnchor.current) return;
    botMenuAnchor.current.focus();
    botMenuAnchor.current = null;
  }, [botMenu]);
  const closeBotMenu = useCallback(() => setBotMenu(null), []);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [leaveGroupTarget, setLeaveGroupTarget] = useState<Group | null>(null);
  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<Space | null>(null);
  const [spaceMenu, setSpaceMenu] = useState<{
    id: string;
    position: ContextMenuPosition;
  } | null>(null);
  const spaceMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (spaceMenu || !spaceMenuAnchor.current) return;
    spaceMenuAnchor.current.focus();
    spaceMenuAnchor.current = null;
  }, [spaceMenu]);
  const closeSpaceMenu = useCallback(() => setSpaceMenu(null), []);
  const [clearTarget, setClearTarget] = useState<ChatTarget | null>(null);
  const [shareTarget, setShareTarget] = useState<Bot | null>(null);
  const [newSectionTarget, setNewSectionTarget] = useState<ChatTarget | null>(null);
  const [renameSectionTarget, setRenameSectionTarget] = useState<{
    section: BotSection;
    spaceId: string;
  } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<{
    section: BotSection;
    spaceId: string;
    position: ContextMenuPosition;
  } | null>(null);
  const sectionMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (sectionMenu || !sectionMenuAnchor.current) return;
    sectionMenuAnchor.current.focus();
    sectionMenuAnchor.current = null;
  }, [sectionMenu]);
  const closeSectionMenu = useCallback(() => setSectionMenu(null), []);
  useEffect(() => {
    if (!sessionUser) return;
    let cancelled = false;
    void rpc.messaging
      .status()
      .then((status) => {
        if (!cancelled) {
          setMessagingSurfaceEnabled(status.enabled);
          setMessagingProviders(status.providers);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionUser]);

  useEffect(() => {
    let cancelled = false;
    const providerConfigRevision = memoryProviderConfigRevision.current;
    void rpc.memory
      .providerConfig()
      .then((providerConfig) => {
        if (!cancelled && memoryProviderConfigRevision.current === providerConfigRevision) {
          setMemoryProviderConfig(providerConfig);
        }
      })
      .catch(() => {
        if (!cancelled && memoryProviderConfigRevision.current === providerConfigRevision) {
          setMemoryProviderConfig(null);
        }
      });
    return () => {
      cancelled = true;
    };
    // The memory provider belongs to the space, so a space switch reloads it.
  }, [spaceId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!isCommandPaletteHotkey(event)) return;
      event.preventDefault();
      setCommandPaletteOpen((open) => !open);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function openSettings(section: SettingsSection | null = null) {
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  function changeMemoryConfig(config: SpaceMemoryConfig | null) {
    memoryProviderConfigRevision.current += 1;
    setMemoryProviderConfig(config);
  }

  return {
    customizeOpen,
    setCustomizeOpen,
    customizeSection,
    settingsOpen,
    setSettingsOpen,
    settingsSection,
    setSettingsSection,
    openSettings,
    messagingSettingsOpen,
    setMessagingSettingsOpen,
    messagingSurfaceEnabled,
    messagingProviders,
    memoryProviderConfig,
    changeMemoryConfig,
    peerConversation,
    setPeerConversation,
    runView,
    setRunView,
    menuOpen,
    setMenuOpen,
    createMenuOpen,
    setCreateMenuOpen,
    newSpaceOpen,
    setNewSpaceOpen,
    pickerInfoTopic,
    setPickerInfoTopic,
    commandPaletteOpen,
    setCommandPaletteOpen,
    botMenu,
    setBotMenu,
    botMenuAnchor,
    closeBotMenu,
    deleteTarget,
    setDeleteTarget,
    deleteGroupTarget,
    setDeleteGroupTarget,
    leaveGroupTarget,
    setLeaveGroupTarget,
    deleteSpaceTarget,
    setDeleteSpaceTarget,
    spaceMenu,
    setSpaceMenu,
    spaceMenuAnchor,
    closeSpaceMenu,
    clearTarget,
    setClearTarget,
    shareTarget,
    setShareTarget,
    newSectionTarget,
    setNewSectionTarget,
    renameSectionTarget,
    setRenameSectionTarget,
    sectionMenu,
    setSectionMenu,
    sectionMenuAnchor,
    closeSectionMenu,
  };
}

export type ShellOverlayState = ReturnType<typeof useShellOverlays>;
