import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { LucideIcon } from "lucide-react";
import {
  Brain,
  CloudDownload,
  Cpu,
  Gauge,
  KeyRound,
  LockKeyhole,
  Monitor,
  Signpost,
  SlidersHorizontal,
  UserRound,
  Volume2,
} from "lucide-react";
import { desktopBridge } from "../lib/desktop";

/** Settings that follow the person across spaces. */
export const ACCOUNT_SETTINGS_SECTIONS = ["profile", "providers", "updates"] as const;

/** Settings that belong to the active space. */
export const SPACE_SETTINGS_SECTIONS = [
  "space",
  "models",
  "voice",
  "memory",
  "decision-model",
  "computer",
  "vault",
  "usage",
] as const;

export type SettingsSection =
  | (typeof ACCOUNT_SETTINGS_SECTIONS)[number]
  | (typeof SPACE_SETTINGS_SECTIONS)[number];

/** Each section's label and icon, read by the Settings window and the ⌘K palette. */
export const SETTINGS_NAV: Record<SettingsSection, { label: MessageDescriptor; icon: LucideIcon }> =
  {
    profile: { label: msg`Profile`, icon: UserRound },
    providers: { label: msg`Providers`, icon: KeyRound },
    updates: { label: msg`Updates`, icon: CloudDownload },
    space: { label: msg`General`, icon: SlidersHorizontal },
    models: { label: msg`Models`, icon: Cpu },
    voice: { label: msg`Voice`, icon: Volume2 },
    memory: { label: msg`Memory`, icon: Brain },
    "decision-model": { label: msg`Decision Model`, icon: Signpost },
    computer: { label: msg`Computer`, icon: Monitor },
    vault: { label: msg`Vault`, icon: LockKeyhole },
    usage: { label: msg`Usage`, icon: Gauge },
  };

/** Updates only concern the desktop app; a browser always runs what the server serves. */
export function accountSettingsSections(): readonly SettingsSection[] {
  return desktopBridge()?.update
    ? ACCOUNT_SETTINGS_SECTIONS
    : ACCOUNT_SETTINGS_SECTIONS.filter((id) => id !== "updates");
}
