import { Field } from "@base-ui/react/field";
import type { ComponentProps, ReactNode } from "react";
import { Input } from "./components/ui/input.js";
import { cn } from "./lib/utils.js";

export type FloatingFieldProps = Omit<ComponentProps<"input">, "children"> & {
  /** The field's accessible name, shown inside it until it has a value or focus. */
  label: ReactNode;
  /** Marks the value itself as wrong; an error about something else leaves it unset. */
  invalid?: boolean;
  /** A control laid over the field's end, such as a show-password button. */
  children?: ReactNode;
};

/** A field whose label sits inside it while empty and rises on focus or once filled. */
export function FloatingField({
  label,
  invalid = false,
  className,
  children,
  ...props
}: FloatingFieldProps) {
  return (
    <Field.Root invalid={invalid} className={cn("rk-floating-field", className)}>
      <Input
        {...props}
        className={cn(
          "h-(--field-h) rounded-card bg-card px-3.5 pt-5.5 pb-1.5 text-body focus-visible:border-foreground focus-visible:ring-foreground/10 aria-invalid:border-foreground aria-invalid:ring-0 md:text-body dark:bg-card dark:aria-invalid:border-foreground",
          children ? "pe-12" : undefined,
        )}
      />
      <Field.Label>{label}</Field.Label>
      {children}
    </Field.Root>
  );
}
