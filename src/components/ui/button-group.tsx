import * as React from "react"

import { cn } from "@/lib/utils"

function ButtonGroup({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md [&>*:not(:first-child):not(:last-child)]:rounded-none [&>*:first-child]:rounded-r-none [&>*:last-child]:rounded-l-none [&>*:not(:first-child)]:-ml-px",
        className
      )}
      {...props}
    />
  )
}

export { ButtonGroup }
