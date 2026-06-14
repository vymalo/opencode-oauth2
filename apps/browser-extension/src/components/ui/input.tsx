import type { InputHTMLAttributes, LabelHTMLAttributes, SelectHTMLAttributes } from "react";

import { cn } from "../../lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("input w-full", className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("select w-full", className)} {...props} />;
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: reusable primitive — callers pass htmlFor to bind it to a control.
  return <label className={cn("text-xs font-medium opacity-70", className)} {...props} />;
}
