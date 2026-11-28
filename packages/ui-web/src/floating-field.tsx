import { Field } from "@base-ui/react/field";
import { ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useId } from "react";
import { Input } from "./components/ui/input.js";
import { cn } from "./lib/utils.js";
import { ONBOARDING_STATUS_ID } from "./onboarding-frame.js";

export type FloatingFieldProps = Omit<ComponentProps<"input">, "children"> & {
  /** The field's accessible name, shown inside it until it has a value or focus. */
  label: ReactNode;
  /** Marks the value itself as wrong; an error about something else leaves it unset. */
  invalid?: boolean;
  /** A control laid over the field's end, such as a show-password button. */
  children?: ReactNode;
  /** A button inside the field's end, such as "Find models". */
  action?: ReactNode;
};

const fieldClass =
  "h-(--field-h) rounded-card bg-card px-3.5 pt-5.5 pb-1.5 text-body focus-visible:border-foreground focus-visible:ring-foreground/10 aria-invalid:border-foreground aria-invalid:ring-0 md:text-body dark:bg-card dark:aria-invalid:border-foreground";

/** A field whose label sits inside it while empty and rises on focus or once filled. */
export function FloatingField({
  label,
  invalid = false,
  className,
  children,
  action,
  ...props
}: FloatingFieldProps) {
  return (
    <Field.Root invalid={invalid} className={cn("rk-floating-field", className)}>
      <Input
        aria-describedby={invalid ? ONBOARDING_STATUS_ID : undefined}
        {...props}
        className={cn(fieldClass, action ? "pe-40" : children ? "pe-12" : undefined)}
      />
      <Field.Label>{label}</Field.Label>
      {children}
      {action}
    </Field.Root>
  );
}

export type FloatingSelectProps = ComponentProps<"select"> & {
  label: ReactNode;
  invalid?: boolean;
};

/** A native list in the same box as `FloatingField`, its label always raised. */
export function FloatingSelect({
  label,
  invalid = false,
  id,
  className,
  ...props
}: FloatingSelectProps) {
  const fallbackId = useId();
  const selectId = id ?? fallbackId;
  return (
    <div className={cn("rk-floating-field", className)}>
      <select
        id={selectId}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? ONBOARDING_STATUS_ID : undefined}
        {...props}
        className={cn(
          fieldClass,
          "w-full min-w-0 appearance-none truncate border border-input pe-10 outline-none focus-visible:ring-3",
        )}
      />
      <label htmlFor={selectId}>{label}</label>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute end-2.75 top-1/2 size-4.5 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
