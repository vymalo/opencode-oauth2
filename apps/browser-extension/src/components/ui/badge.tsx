import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

// daisyUI `badge` with soft tones — calm tinted pills rather than solid fills.
const badge = cva("badge badge-soft gap-1.5", {
  variants: {
    tone: {
      neutral: "badge-neutral",
      ok: "badge-success",
      warn: "badge-warning",
      danger: "badge-error",
      accent: "badge-primary"
    }
  },
  defaultVariants: { tone: "neutral" }
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
