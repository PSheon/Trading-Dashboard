"use client"

import * as React from "react"
import { Check, ChevronDown, Search } from "lucide-react"
import { Popover as PopoverPrimitive, Select as Primitive } from "radix-ui"
import { cn } from "cn"

/**
 * The one select of the app (C-Styles v29). The trigger is a capsule —
 * radius half its height — in the well colour (raised on the page, inset in
 * a card) with a chevron: `size="md"` 48 px like a form input, `size="sm"`
 * 44 px in toolbars and filters (the standard button tier). An optional
 * `prefix` puts a muted label before the value ("角色 全部"), as the board's
 * filter pills do. The panel has 22 px corners, 44 px items with a check on
 * the selected one, and scrolls when the list is long.
 *
 * Radix Select carries the keyboard and screen-reader behaviour (arrows,
 * Home/End, typeahead, Escape, focus return). `searchable` swaps in a
 * combobox — a text field over a listbox in a popover — for long lists.
 */
export interface SelectOption<T extends string = string> {
  value: T
  label: React.ReactNode
  /** Plain text for typeahead and search when `label` is not a string. */
  text?: string
  /** A muted note at the item's end (a type, a volume, "已選"). */
  hint?: React.ReactNode
  disabled?: boolean
}

// Radix Select reserves "" (it clears the selection); native selects used it
// for "all". It is mapped to this inside and back to "" outside.
const EMPTY = "__select-empty__"
const toInner = (value: string, hasEmpty = true) => (value === "" ? (hasEmpty ? EMPTY : "") : value)
const toOuter = (value: string) => (value === EMPTY ? "" : value)

export const selectTriggerClass = (size: "row" | "sm" | "md" = "md", className?: string) =>
  cn(
    "group/select inline-flex min-w-0 items-center justify-between gap-2 rounded-full border-2 border-transparent bg-(--seg-track,var(--raised)) pr-3.5 pl-[18px] text-left font-extrabold text-foreground outline-none transition-colors hover:bg-raised-hover focus-visible:border-primary disabled:pointer-events-none disabled:opacity-50 data-[placeholder]:text-subtle-foreground aria-expanded:bg-raised-hover",
    size === "md" ? "h-12 text-[15px]" : size === "sm" ? "h-11 text-[15px]" : "h-9 pr-2.5 pl-3 text-sm",
    className,
  )

const panelClass =
  "z-50 overflow-hidden rounded-[22px] bg-popover p-1.5 text-popover-foreground shadow-[0_0_0_2px_var(--card-ring),var(--shadow-pop)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:data-[state=open]:zoom-in-100"

const itemClass =
  "relative flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-[16px] pr-3 pl-3.5 text-left text-[15px] font-bold outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-raised-hover data-[state=checked]:font-extrabold"

const textOf = (option: SelectOption) => option.text ?? (typeof option.label === "string" ? option.label : option.value)

export interface SelectProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: SelectOption<T>[]
  /** The accessible name when no visible <label htmlFor={id}> names it. */
  label?: string
  id?: string
  placeholder?: string
  /** md = 48 px form field; sm = 44 px toolbar / filter pill; row = 36 px
   * inside a table row (the in-row button tier). */
  size?: "row" | "sm" | "md"
  /** A muted label inside the trigger, before the value. */
  prefix?: React.ReactNode
  /** Shown in the trigger instead of the selected option's label. */
  display?: React.ReactNode
  disabled?: boolean
  className?: string
  contentClassName?: string
  align?: "start" | "end" | "center"
  /** A search field over the list (long lists). */
  searchable?: boolean
  searchPlaceholder?: string
  /** Shown when a search matches nothing. */
  emptyText?: string
  name?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean
}

export function Select<T extends string>(props: SelectProps<T>) {
  if (props.searchable) return <SearchSelect {...props} />
  const {
    value, onValueChange, options, label, id, placeholder, size = "md", prefix, display, disabled,
    className, contentClassName, align = "start", name,
  } = props
  return (
    <Primitive.Root
      // "" with no "" option: nothing chosen, the placeholder shows.
      value={toInner(value, options.some((option) => option.value === ""))}
      onValueChange={(next) => onValueChange(toOuter(next) as T)}
      disabled={disabled}
      name={name}
    >
      <Primitive.Trigger
        id={id}
        aria-label={label}
        aria-describedby={props["aria-describedby"]}
        aria-invalid={props["aria-invalid"]}
        data-slot="select-trigger"
        className={selectTriggerClass(size, className)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {prefix ? <span className="shrink-0 font-bold text-muted-foreground">{prefix}</span> : null}
          <span className="min-w-0 truncate">
            <Primitive.Value placeholder={placeholder}>{display}</Primitive.Value>
          </span>
        </span>
        <Primitive.Icon asChild>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-aria-expanded/select:rotate-180 motion-reduce:transition-none" strokeWidth={2.6} aria-hidden />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          position="popper"
          sideOffset={8}
          align={align}
          collisionPadding={12}
          data-slot="select-content"
          className={cn(
            panelClass,
            "max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-24px)]",
            contentClassName,
          )}
        >
          <Primitive.Viewport className="max-h-[inherit] overflow-y-auto">
            {options.map((option) => (
              <Primitive.Item
                key={option.value}
                value={toInner(option.value)}
                disabled={option.disabled}
                textValue={textOf(option)}
                data-value={option.value}
                className={itemClass}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <Primitive.ItemIndicator>
                    <Check className="size-4 text-primary-text" strokeWidth={3} aria-hidden />
                  </Primitive.ItemIndicator>
                </span>
                <Primitive.ItemText>{option.label}</Primitive.ItemText>
                {option.hint ? <span className="ml-auto pl-3 text-xs font-bold whitespace-nowrap text-muted-foreground">{option.hint}</span> : null}
              </Primitive.Item>
            ))}
          </Primitive.Viewport>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  )
}

/**
 * The searchable variant: a button opening a popover with a combobox text
 * field (aria-activedescendant) over a listbox. Arrow keys move, Enter picks,
 * Escape closes and returns focus to the trigger.
 */
function SearchSelect<T extends string>({
  value, onValueChange, options, label, id, placeholder, size = "md", prefix, display, disabled,
  className, contentClassName, align = "start", searchPlaceholder, emptyText, ...rest
}: SelectProps<T>) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  const listId = React.useId()
  const listRef = React.useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)
  const q = query.trim().toLowerCase()
  const shown = q ? options.filter((option) => textOf(option).toLowerCase().includes(q) || option.value.toLowerCase().includes(q)) : options

  const openChange = (next: boolean) => {
    if (next) {
      setQuery("")
      setActive(Math.max(0, options.findIndex((option) => option.value === value)))
    }
    setOpen(next)
  }

  React.useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const pick = (option: SelectOption<T> | undefined) => {
    if (!option || option.disabled) return
    onValueChange(option.value)
    setOpen(false)
  }
  const move = (delta: number) => {
    if (!shown.length) return
    let next = active
    for (let i = 0; i < shown.length; i++) {
      next = (next + delta + shown.length) % shown.length
      if (!shown[next]!.disabled) break
    }
    setActive(next)
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={openChange}>
      <PopoverPrimitive.Trigger
        id={id}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-describedby={rest["aria-describedby"]}
        data-placeholder={selected ? undefined : ""}
        data-slot="select-trigger"
        className={selectTriggerClass(size, className)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {prefix ? <span className="shrink-0 font-bold text-muted-foreground">{prefix}</span> : null}
          <span className="min-w-0 truncate">{display ?? selected?.label ?? placeholder}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-aria-expanded/select:rotate-180 motion-reduce:transition-none" strokeWidth={2.6} aria-hidden />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={8}
          align={align}
          collisionPadding={12}
          data-slot="select-content"
          className={cn(panelClass, "flex w-[var(--radix-popover-trigger-width)] min-w-56 max-w-[calc(100vw-24px)] flex-col", contentClassName)}
        >
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
              aria-label={label ?? placeholder}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); move(1) }
                else if (event.key === "ArrowUp") { event.preventDefault(); move(-1) }
                else if (event.key === "Home") { event.preventDefault(); setActive(0) }
                else if (event.key === "End") { event.preventDefault(); setActive(Math.max(0, shown.length - 1)) }
                else if (event.key === "Enter") { event.preventDefault(); pick(shown[active]) }
              }}
              className="h-11 w-full rounded-full border-2 border-transparent bg-inset pr-4 pl-10 text-[15px] font-bold text-foreground outline-none placeholder:text-subtle-foreground focus-visible:border-primary"
            />
          </div>
          <div ref={listRef} id={listId} role="listbox" aria-label={label ?? placeholder} className="max-h-[300px] overflow-y-auto">
            {shown.length ? shown.map((option, index) => {
              const checked = option.value === value
              return (
                <div
                  key={option.value}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={checked}
                  aria-disabled={option.disabled || undefined}
                  data-index={index}
                  data-value={option.value}
                  data-highlighted={index === active ? "" : undefined}
                  data-state={checked ? "checked" : "unchecked"}
                  data-disabled={option.disabled ? "" : undefined}
                  onPointerMove={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(option)}
                  className={itemClass}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {checked ? <Check className="size-4 text-primary-text" strokeWidth={3} aria-hidden /> : null}
                  </span>
                  <span className="min-w-0 truncate">{option.label}</span>
                  {option.hint ? <span className="ml-auto pl-3 text-xs font-bold whitespace-nowrap text-muted-foreground">{option.hint}</span> : null}
                </div>
              )
            }) : <p className="px-3.5 py-3 text-sm font-bold text-muted-foreground">{emptyText ?? "—"}</p>}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
