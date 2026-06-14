import type { HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

// daisyUI `card` shell on a raised surface; the Header/Title/Content split keeps
// the existing call sites unchanged while leaning on daisyUI's card spacing.
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card border border-base-300 bg-base-200", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pt-5 pb-2", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("card-title text-base", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}
