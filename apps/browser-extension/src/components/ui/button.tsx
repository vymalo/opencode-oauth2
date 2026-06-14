import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/utils";

// Thin typed wrapper over daisyUI's `btn` — variants map straight to daisyUI
// modifier classes so there's no bespoke styling to maintain.
const button = cva("btn", {
  variants: {
    variant: {
      default: "btn-primary",
      outline: "btn-outline",
      ghost: "btn-ghost",
      danger: "btn-error"
    },
    size: {
      sm: "btn-sm",
      md: ""
    }
  },
  defaultVariants: { variant: "default", size: "md" }
});

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(button({ variant, size }), className)} {...props} />;
}
