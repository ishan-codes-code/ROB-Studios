import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"
import { cn } from "cn"

// Mirrors the shadcn Progress pattern using this repo's radix-ui meta
// package and Obsidian tokens (track secondary, fill primary).
function Progress({
  className,
  value,
  max = 100,
  ...props
}) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      max={max}
      className={cn(
        "bg-secondary relative flex h-2 w-full overflow-hidden rounded-full",
        className
      )}
      {...props}>
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-primary h-full w-full flex-1 transition-transform duration-150 motion-reduce:transition-none"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }} />
    </ProgressPrimitive.Root>
  );
}

export { Progress }
