import { useLingui } from "@lingui/react/macro";
import type { ComputerListItem, SpaceMemoryConfig } from "@tangow/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  SettingRow,
  UserAvatar,
} from "@tangow/ui-web";
import { ChevronsUpDown, CloudDownload, XIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { useMediaQuery } from "../lib/use-media-query";
import { ProfileSettingsPanels, UpdatesSettingsPanel } from "./AccountSettingsOverlay";
import { BackCapsule } from "./BackCapsule";
import { SettingsGroup } from "./bot-page/page-kit";
import { ComputerSettingsPanel } from "./ComputerSettingsPanel";
import { DecisionModelSettingsPanel } from "./DecisionModelSettingsPanel";
import { MemorySettingsOverlay } from "./MemorySettingsOverlay";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";
import type { ProviderDetail } from "./ProvidersSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { SpaceGeneralSettings } from "./SpaceGeneralSettings";
import type { SettingsSection } from "./settings-sections";
import {
  accountSettingsSections,
  SETTINGS_NAV,
  SPACE_SETTINGS_SECTIONS,
} from "./settings-sections";
import { PHONE_MEDIA } from "./shell/layout";
import { UsageSettingsPanel } from "./usage-settings";
import { usePushedFocus } from "./use-pushed-focus";
import { VaultSettingsPanel } from "./VaultSettingsPanel";
import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

type NavItem = {
  updateAvailable?: boolean;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
};

type SettingsSpace = { id: string; name: string; canRename?: boolean };

export function SettingsOverlay({
  email,
  name,
  initials,
  image,
  initialSection = null,
  isDeploymentOwner = false,
  messagingEnabled = false,
  onOpenMessaging,
  memoryConfig,
  onMemoryConfigChange,
  spaces,
  currentSpaceId,
  onSwitchSpace,
  onSpaceRenamed,
  onClose,
  onVoiceStatusMaybeChanged,
  userId,
}: {
  email?: string | null;
  name: string;
  initials: string;
  image: string | null;
  initialSection?: SettingsSection | null;
  isDeploymentOwner?: boolean;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
  memoryConfig: SpaceMemoryConfig | null | undefined;
  onMemoryConfigChange: (config: SpaceMemoryConfig | null) => void;
  spaces: SettingsSpace[];
  currentSpaceId: string | undefined;
  onSwitchSpace: (spaceId: string) => void;
  onSpaceRenamed?: () => void | Promise<void>;
  onClose: () => void;
  onVoiceStatusMaybeChanged?: () => void | Promise<void>;
  userId?: string;
}) {
  const { t } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const usageRef = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery(PHONE_MEDIA);
  const [chosen, setChosen] = useState<SettingsSection | null>(
    initialSection ?? (phone ? null : "profile"),
  );
  // A phone shows the list of sections until one is chosen; a window always shows one.
  const section = phone ? chosen : (chosen ?? "profile");
  // A phone also pushes a chosen provider over the Providers list. The choice is kept at
  // any width, so a window narrowed to a phone keeps the provider it was showing.
  const [chosenProvider, setProviderDetail] = useState<ProviderDetail | null>(null);
  const providerDetail = phone && section === "providers" ? chosenProvider : null;
  function setSection(next: SettingsSection | null) {
    setProviderDetail(null);
    setChosen(next);
  }
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [decisionModelBusy, setDecisionModelBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [providersBusy, setProvidersBusy] = useState(false);
  const [computerUpdateAvailable, setComputerUpdateAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void rpc.computer
      .list()
      .then((items: ComputerListItem[]) => {
        if (active) setComputerUpdateAvailable(items.some((item) => item.status.updateAvailable));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [section, currentSpaceId]);
  const panelBusy = memoryBusy || decisionModelBusy || voiceBusy || providersBusy;

  useEffect(() => {
    if (section === "usage") {
      usageRef.current?.focus();
    }
  }, [section]);

  const back = usePushedFocus(section, panelRef);
  const providerBack = usePushedFocus(providerDetail?.key ?? null, panelRef);

  const accountSections = accountSettingsSections();

  const navItem = (id: SettingsSection): NavItem => ({
    label: t(SETTINGS_NAV[id].label),
    icon: SETTINGS_NAV[id].icon,
    updateAvailable: id === "computer" && computerUpdateAvailable,
  });

  const sectionTitle = providerDetail
    ? providerDetail.title
    : section
      ? navItem(section).label
      : t`Settings`;

  const closeLabel =
    section === "models"
      ? t`Close model settings`
      : section === "memory"
        ? t`Close memory settings`
        : section === "voice"
          ? t`Close voice settings`
          : t`Close user settings`;

  async function refreshVoiceStatus() {
    await onVoiceStatusMaybeChanged?.();
  }

  function leaveSettings(next: () => void) {
    if (panelBusy) return;
    void refreshVoiceStatus().finally(next);
  }

  function requestClose() {
    leaveSettings(onClose);
  }

  const spaceLabelId = useId();
  const currentSpace = spaces.find((space) => space.id === currentSpaceId);
  const spaceSwitcher = (
    <SpaceSwitcher
      labelId={spaceLabelId}
      spaces={spaces}
      currentSpaceId={currentSpaceId}
      disabled={panelBusy}
      onSwitch={(spaceId) => {
        if (panelBusy) return;
        onSwitchSpace(spaceId);
      }}
    />
  );
  const closeButton = (
    <DialogClose
      aria-label={closeLabel}
      disabled={panelBusy}
      render={<Button variant="ghost" size="icon-sm" className="ms-auto" />}
    >
      <XIcon />
    </DialogClose>
  );

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (panelBusy) {
          details.cancel();
          return;
        }
        requestClose();
      }}
    >
      <DialogContent
        variant="window"
        ref={panelRef}
        data-testid="user-settings"
        data-settings-section={section}
        showCloseButton={false}
        initialFocus={() =>
          section === "usage" ? (usageRef.current ?? panelRef.current) : panelRef.current
        }
        className="h-[min(760px,calc(100%-2rem))] max-h-[calc(100%-2rem)] w-[min(1080px,calc(100%-2rem))] sm:max-h-[calc(100%-5rem)] sm:max-w-[1080px]"
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {phone ? null : (
            <nav
              data-testid="settings-nav"
              aria-label={t`Settings`}
              // Beside the content, an inset panel like the app's sidebar.
              className="m-2 flex w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto rounded-xl bg-group p-2 shadow-group"
            >
              <div className="flex items-center gap-2.5 px-2.5 pt-1.5 pb-2.5">
                <UserAvatar initials={initials} image={image} className="size-6 text-label" />
                <span className="truncate text-row-name font-semibold text-foreground">{name}</span>
              </div>
              {accountSections.map((id) => (
                <SettingsNavButton
                  key={id}
                  id={id}
                  item={navItem(id)}
                  active={id === section}
                  disabled={panelBusy}
                  onSelect={setSection}
                />
              ))}
              <div aria-hidden="true" className="mx-1 my-2 h-px shrink-0 bg-border" />
              {spaceSwitcher}
              <fieldset
                aria-labelledby={currentSpace ? spaceLabelId : undefined}
                className="contents"
              >
                {SPACE_SETTINGS_SECTIONS.map((id) => (
                  <SettingsNavButton
                    key={id}
                    id={id}
                    item={navItem(id)}
                    active={id === section}
                    disabled={panelBusy}
                    onSelect={setSection}
                  />
                ))}
              </fieldset>
            </nav>
          )}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {phone ? (
              <div className="box-content flex h-capsule shrink-0 items-center justify-between gap-1 px-2.5 pt-2.5">
                {providerDetail ? (
                  <BackCapsule
                    ref={providerBack}
                    label={navItem("providers").label}
                    disabled={panelBusy}
                    onClick={() => setProviderDetail(null)}
                  />
                ) : section ? (
                  <BackCapsule
                    ref={back}
                    label={t`Settings`}
                    disabled={panelBusy}
                    onClick={() => setSection(null)}
                  />
                ) : null}
                {closeButton}
              </div>
            ) : null}
            <div className="flex items-start justify-between gap-4 px-6 pt-6 sm:px-8 sm:pt-7">
              <DialogTitle className="text-2xl font-medium text-foreground">
                {sectionTitle}
              </DialogTitle>
              {phone ? null : closeButton}
            </div>

            <div
              // Space panels load once on mount, so a space switch remounts them for the new space.
              key={currentSpaceId}
              className={`min-h-0 flex-1 ${
                section === "providers" ||
                section === "models" ||
                section === "voice" ||
                section === "memory" ||
                section === "decision-model"
                  ? "flex flex-col overflow-hidden"
                  : "rk-scroll overflow-y-auto overscroll-contain px-6 pb-6 pt-5 sm:px-8 sm:pb-8"
              }`}
            >
              {section === null ? (
                <SettingsList
                  navItem={navItem}
                  accountSections={accountSections}
                  disabled={panelBusy}
                  spaceSwitcher={spaceSwitcher}
                  spaceLabelId={currentSpace ? spaceLabelId : undefined}
                  onSelect={setSection}
                />
              ) : null}
              {section === "profile" ? (
                <ProfileSettingsPanels
                  email={email}
                  name={name}
                  initials={initials}
                  isDeploymentOwner={isDeploymentOwner}
                />
              ) : null}
              {section === "providers" ? (
                <ProvidersSettings
                  onBusyChange={setProvidersBusy}
                  stacked={phone}
                  detailOpen={providerDetail !== null}
                  onOpenDetail={setProviderDetail}
                />
              ) : null}
              {section === "space" ? (
                <SpaceGeneralSettings
                  space={currentSpace}
                  onSpaceRenamed={onSpaceRenamed}
                  messagingEnabled={messagingEnabled}
                  onOpenMessaging={
                    onOpenMessaging ? () => leaveSettings(onOpenMessaging) : undefined
                  }
                  onOpenDecisionModel={() => setSection("decision-model")}
                />
              ) : null}
              {section === "usage" ? <UsageSettingsPanel panelRef={usageRef} /> : null}
              {section === "vault" ? (
                <VaultSettingsPanel space={currentSpace} userId={userId} />
              ) : null}
              {section === "computer" ? (
                <ComputerSettingsPanel onUpdateAvailableChange={setComputerUpdateAvailable} />
              ) : null}
              {section === "updates" ? (
                <UpdatesSettingsPanel isDeploymentOwner={isDeploymentOwner} />
              ) : null}
              {section === "models" ? (
                <ModelSettingsOverlay embedded onClose={requestClose} />
              ) : null}
              {section === "memory" ? (
                <MemorySettingsOverlay
                  embedded
                  onClose={requestClose}
                  config={memoryConfig}
                  onConfigChange={onMemoryConfigChange}
                  onBusyChange={setMemoryBusy}
                />
              ) : null}
              {section === "decision-model" ? (
                <DecisionModelSettingsPanel onBusyChange={setDecisionModelBusy} />
              ) : null}
              {section === "voice" ? (
                <VoiceSettingsOverlay
                  embedded
                  onClose={requestClose}
                  onBusyChange={setVoiceBusy}
                  onOpenProviders={() => setSection("providers")}
                />
              ) : null}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingsNavButton({
  id,
  item,
  active,
  disabled,
  onSelect,
}: {
  id: SettingsSection;
  item: NavItem;
  active: boolean;
  disabled: boolean;
  onSelect: (section: SettingsSection) => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      data-testid={`settings-nav-${id}`}
      aria-current={active ? "page" : undefined}
      disabled={disabled}
      onClick={() => onSelect(id)}
      className={`flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13.5px] transition-colors disabled:pointer-events-none disabled:opacity-50 ${
        active
          ? "bg-sidebar-accent text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      }`}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="whitespace-nowrap">{item.label}</span>
      {item.updateAvailable ? <UpdateAvailableIcon /> : null}
    </button>
  );
}

function UpdateAvailableIcon() {
  const { t } = useLingui();
  return (
    <span role="img" aria-label={t`Update available`} title={t`Update available`}>
      <CloudDownload className="size-4 shrink-0" aria-hidden />
    </span>
  );
}

/** At phone width the sections are a list the person picks from, grouped as the window's nav. */
function SettingsList({
  navItem,
  accountSections,
  disabled,
  spaceSwitcher,
  spaceLabelId,
  onSelect,
}: {
  navItem: (id: SettingsSection) => NavItem;
  accountSections: readonly SettingsSection[];
  disabled: boolean;
  spaceSwitcher: ReactNode;
  spaceLabelId: string | undefined;
  onSelect: (section: SettingsSection) => void;
}) {
  const rows = (ids: readonly SettingsSection[]) =>
    ids.map((id) => {
      const { label, icon: Icon, updateAvailable } = navItem(id);
      return (
        <SettingRow
          key={id}
          data-testid={`settings-list-${id}`}
          data-opens={id}
          leading={<Icon className="size-4 text-muted-foreground" strokeWidth={1.75} />}
          label={label}
          value={updateAvailable ? <UpdateAvailableIcon /> : undefined}
          chevron
          disabled={disabled}
          className="disabled:pointer-events-none disabled:opacity-50"
          onClick={() => onSelect(id)}
        />
      );
    });
  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup>{rows(accountSections)}</SettingsGroup>
      <div className="flex flex-col gap-1.5">
        {spaceSwitcher}
        <fieldset aria-labelledby={spaceLabelId} className="contents">
          <SettingsGroup>{rows(SPACE_SETTINGS_SECTIONS)}</SettingsGroup>
        </fieldset>
      </div>
    </div>
  );
}

function SpaceTile({ name, current }: { name: string; current: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-5.5 shrink-0 place-items-center rounded-chip text-label ${
        current ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
      }`}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Names the space the group below edits, and switches it when there is more than one. */
function SpaceSwitcher({
  labelId,
  spaces,
  currentSpaceId,
  disabled,
  onSwitch,
}: {
  labelId: string;
  spaces: SettingsSpace[];
  currentSpaceId: string | undefined;
  disabled: boolean;
  onSwitch: (spaceId: string) => void;
}) {
  const { t } = useLingui();
  const current = spaces.find((space) => space.id === currentSpaceId);
  if (!current) return null;
  const label = (
    <>
      <SpaceTile name={current.name} current />
      <span id={labelId} className="min-w-0 flex-1 truncate text-start text-row-name font-semibold">
        {current.name}
      </span>
    </>
  );
  if (spaces.length < 2) {
    return (
      <div
        data-testid="settings-space-label"
        className="flex shrink-0 items-center gap-2.5 px-2.5 py-2 text-foreground"
      >
        {label}
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="settings-space-switcher"
        aria-label={t`Switch space`}
        disabled={disabled}
        className="flex shrink-0 items-center gap-2.5 rounded-row bg-muted px-2.5 py-2 text-foreground transition-colors hover:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-sidebar-accent md:mb-1"
      >
        {label}
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" data-testid="settings-space-menu">
        <DropdownMenuRadioGroup
          value={current.id}
          onValueChange={(spaceId: string) => {
            if (spaceId !== current.id) onSwitch(spaceId);
          }}
        >
          {spaces.map((space) => (
            <DropdownMenuRadioItem key={space.id} value={space.id} className="gap-2.5 py-1.5">
              <SpaceTile name={space.name} current={space.id === current.id} />
              <span className="truncate text-row-name">{space.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
