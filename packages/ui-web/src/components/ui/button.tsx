import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@tangow/ui-web/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { Lock } from "lucide-react";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
        // Quiet — see docs/design-system.md. Pair each one with its matching `size`.
        capsule:
          "rounded-full bg-primary px-3.75 text-capsule font-medium text-primary-foreground duration-(--duration-hover) ease-quiet hover:opacity-85",
        capsuleSecondary:
          "rounded-full bg-secondary px-3.75 text-capsule font-normal text-foreground duration-(--duration-hover) ease-quiet hover:opacity-85",
        tertiary:
          "rounded-full bg-transparent px-3 text-capsule font-normal text-muted-foreground duration-(--duration-hover) ease-quiet hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground",
        quickReply:
          "rounded-full border-option-ring bg-transparent px-4 text-capsule font-medium text-foreground duration-(--duration-hover) ease-quiet hover:border-option-ring-hover hover:bg-accent",
        roundIcon:
          "rounded-full bg-transparent p-0 text-muted-foreground duration-(--duration-hover) ease-quiet hover:bg-accent hover:text-foreground",
        roundIconSecondary:
          "rounded-full bg-secondary p-0 text-foreground duration-(--duration-hover) ease-quiet hover:opacity-85",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
        // Quiet — heights and square sizes come from the `--size-*` tokens, and
        // the size also decides how the button settles under a press: a capsule
        // to 0.96, a round control to 0.94.
        capsule: "rk-press h-capsule gap-1.5",
        quickReply: "rk-press h-quick-reply gap-1.5",
        roundIcon: "rk-press-round size-composer-icon",
        roundIconSm: "rk-press-round size-hover-icon",
        stack: "rk-press h-mobile-stack gap-2",
        call: "rk-press-round size-call-button",
        full: "rk-press h-primary-button w-full gap-2 rounded-full text-question",
      },
    },
    compoundVariants: [
      {
        size: ["icon", "icon-xs", "icon-sm", "icon-lg", "roundIcon", "roundIconSm"],
        className: "rk-tap",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Prefixes a lock so a consequential action reads as one before it is pressed. */
    consequential?: boolean;
  };

function Button({
  className,
  variant = "default",
  size = "default",
  consequential,
  children,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-consequential={consequential ? "true" : undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {consequential ? (
        <>
          <Lock aria-hidden="true" className="size-3.25" />
          {children}
        </>
      ) : (
        children
      )}
    </ButtonPrimitive>
  );
}

export type { ButtonProps };
export { Button, buttonVariants };
