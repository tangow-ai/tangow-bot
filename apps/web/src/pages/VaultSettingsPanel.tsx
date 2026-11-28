import { useLingui } from "@lingui/react/macro";
import type { BotSecretDestination, SpaceMembers, VaultItem, VaultList } from "@tangow/contracts";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  SegmentedControl,
  SettingRow,
  Switch,
  UserAvatar,
} from "@tangow/ui-web";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { userInitials } from "../lib/user-initials";
import { PendingRead, SettingsGroup, useConfirm } from "./bot-page/page-kit";

type AuthType = BotSecretDestination["auth"]["type"];

/** "api.example.com" or a full URL, as the HTTPS origin a credential is bound to. */
function siteOrigin(site: string): string {
  const trimmed = site.trim();
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).origin;
  } catch {
    return trimmed;
  }
}

type Member = SpaceMembers["members"][number];
type Space = { id: string; name: string };

/**
 * The person's credentials in this space, then the ones others share with them (read-only).
 * Values are write-only: never read back.
 */
export function VaultSettingsPanel({ space, userId }: { space?: Space; userId?: string }) {
  const { t } = useLingui();
  const [vault, setVault] = useState<VaultList | null>(null);
  const [people, setPeople] = useState<Member[]>([]);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<VaultItem | "new" | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    rpc.vault
      .list()
      .then(setVault)
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!space) return;
    let live = true;
    rpc.spaces.members({ spaceId: space.id }).then(
      (view) => live && setPeople(view.members.filter((member) => member.userId !== userId)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [space, userId]);

  const sharedWith = (item: VaultItem) =>
    item.space
      ? t`Everyone`
      : people
          .filter((member) => item.userIds.includes(member.userId))
          .map((member) => member.name)
          .join(", ");

  return (
    <div data-testid="vault-settings" className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>
          <Plus />
          {t`Add`}
        </Button>
      </div>
      {vault === null ? (
        <PendingRead failed={failed} onRetry={load} />
      ) : (
        <>
          {vault.mine.length > 0 ? (
            <SettingsGroup>
              {vault.mine.map((item) => (
                <SettingRow
                  key={item.name}
                  label={item.name}
                  subline={[new URL(item.origin).host, sharedWith(item)]
                    .filter(Boolean)
                    .join(" · ")}
                  chevron
                  onClick={() => setEditing(item)}
                />
              ))}
            </SettingsGroup>
          ) : null}
          {vault.shared.length > 0 ? (
            <SettingsGroup label={t`Shared with you`}>
              {vault.shared.map((item) => (
                <SettingRow
                  key={`${item.ownerName}:${item.name}:${item.origin}`}
                  label={item.name}
                  subline={`${new URL(item.origin).host} · ${item.ownerName}`}
                />
              ))}
            </SettingsGroup>
          ) : null}
        </>
      )}
      {editing ? (
        <VaultItemDialog
          item={editing === "new" ? null : editing}
          space={space}
          people={people}
          onShared={load}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

/** Adds a credential, or replaces the value of `item` and offers to delete it. */
function VaultItemDialog({
  item,
  space,
  people,
  onShared,
  onClose,
  onSaved,
}: {
  item: VaultItem | null;
  space?: Space;
  people: Member[];
  onShared: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLingui();
  const { confirm, dialog } = useConfirm();
  const [site, setSite] = useState("");
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<AuthType>("bearer");
  const [authField, setAuthField] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready =
    Boolean(value) &&
    (item !== null ||
      (Boolean(site.trim() && name) && (authType === "bearer" || Boolean(authField.trim()))));

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not save`);
      setBusy(false);
    }
  }

  function save() {
    if (!ready || busy) return;
    const auth: BotSecretDestination["auth"] =
      authType === "header"
        ? { type: "header", name: authField.trim() }
        : authType === "basic"
          ? { type: "basic", username: authField.trim() }
          : { type: "bearer" };
    const destination = item ?? { name, origin: siteOrigin(site), auth };
    // Cleared before the request, so the value is never shown again.
    setValue("");
    void run(() => rpc.vault.put({ ...destination, value }));
  }

  async function remove() {
    if (!item || busy || !(await confirm(t`Delete ${item.name}?`, t`Delete`))) return;
    void run(() => rpc.vault.remove({ name: item.name }));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent data-testid="vault-item-dialog">
        <DialogHeader>
          <DialogTitle>{item ? item.name : t`New API key`}</DialogTitle>
        </DialogHeader>
        {item && space && people.length > 0 ? (
          <KeySharing item={item} space={space} people={people} onShared={onShared} />
        ) : null}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {item ? null : (
            <>
              <LabeledInput
                label={t`Site`}
                value={site}
                onChange={setSite}
                placeholder="api.example.com"
                autoFocus
              />
              <LabeledInput
                label={t`Name`}
                value={name}
                // Names are what the bot calls the key by: lowercase letters, digits and "_".
                onChange={(next) => setName(next.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
                placeholder="example_api"
              />
              <div className="flex flex-col gap-2">
                <Label>{t`Sent as`}</Label>
                <SegmentedControl
                  aria-label={t`Sent as`}
                  value={authType}
                  onValueChange={(next) => {
                    setAuthType(next);
                    setAuthField("");
                  }}
                  options={[
                    { value: "bearer", label: "Bearer" },
                    { value: "header", label: t`Header` },
                    { value: "basic", label: "Basic" },
                  ]}
                  className="self-start"
                />
              </div>
              {authType === "header" ? (
                <LabeledInput
                  label={t`Header name`}
                  value={authField}
                  onChange={setAuthField}
                  placeholder="X-Api-Key"
                />
              ) : authType === "basic" ? (
                <LabeledInput label={t`Username`} value={authField} onChange={setAuthField} />
              ) : null}
            </>
          )}
          <LabeledInput
            label={t`Key`}
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={setValue}
            autoFocus={item !== null}
          />
          {error ? <p className="text-meta text-destructive">{error}</p> : null}
          <DialogFooter>
            {item ? (
              <Button
                type="button"
                variant="ghost"
                className="me-auto text-destructive"
                disabled={busy}
                onClick={() => void remove()}
              >
                {t`Delete`}
              </Button>
            ) : null}
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {item ? t`Replace key` : t`Save`}
            </Button>
          </DialogFooter>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Who the owner shares one key with; each change saves itself. "Everyone" is the owner's explicit
 * choice and also covers people who join the space later.
 */
function KeySharing({
  item,
  space,
  people,
  onShared,
}: {
  item: VaultItem;
  space: Space;
  people: Member[];
  onShared: () => void;
}) {
  const { t } = useLingui();
  const [share, setShare] = useState({ userIds: item.userIds, space: item.space });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: typeof share) {
    const previous = share;
    setShare(next);
    setPending(true);
    setError(null);
    try {
      await rpc.vault.share({ name: item.name, ...next });
      onShared();
    } catch {
      setShare(previous);
      setError(t`Couldn't save`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>{t`Shared with`}</Label>
      <SettingsGroup>
        <SettingRow label={t`Everyone in ${space.name}`}>
          <Switch
            aria-label={t`Everyone in ${space.name}`}
            checked={share.space}
            disabled={pending}
            onCheckedChange={(checked) => void save({ ...share, space: checked })}
          />
        </SettingRow>
        {share.space
          ? null
          : people.map((member) => (
              <SettingRow
                key={member.userId}
                leading={
                  <UserAvatar
                    initials={userInitials(member.name)}
                    image={member.image}
                    className="size-7 text-label"
                  />
                }
                label={member.name}
              >
                <Checkbox
                  aria-label={member.name}
                  checked={share.userIds.includes(member.userId)}
                  disabled={pending}
                  onCheckedChange={(checked) =>
                    void save({
                      ...share,
                      userIds: checked
                        ? [...share.userIds, member.userId]
                        : share.userIds.filter((id) => id !== member.userId),
                    })
                  }
                />
              </SettingRow>
            ))}
      </SettingsGroup>
      {share.space ? (
        <p className="text-meta text-muted-foreground">
          {t`Every current and future member of ${space.name} can use this key on its site, from their bots and yours that you can see, including webhooks and routines.`}
        </p>
      ) : share.userIds.length > 0 ? (
        <p className="text-meta text-muted-foreground">
          {t`These people can use this key on its site, from their bots and yours that you can see, including webhooks and routines.`}
        </p>
      ) : null}
      {error ? <p className="text-meta text-destructive">{error}</p> : null}
    </div>
  );
}

function LabeledInput({
  label,
  onChange,
  ...props
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} onChange={(event) => onChange(event.target.value)} {...props} />
    </div>
  );
}
