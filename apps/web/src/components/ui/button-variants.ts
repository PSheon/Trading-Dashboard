import { cva, type VariantProps } from "class-variance-authority"

/**
 * Orbit pill buttons — the C-Styles (v29) token sheet. Three tiers plus the
 * header: `cta` 56 px (Fredoka 600 18, 32 px sides: follow, start
 * exploring, empty states), `default` 44 px and `sm` 36 px in a row (Nunito
 * 800), and `header` 52 px, which only the top bar uses. The radius is
 * always half the height; text on orange is always the dark #1a1533.
 * Secondary is the beige well (raised / inset), `inverse` dark ink, `destructive` the
 * peach/brown danger pair. Press scales down; reduced motion keeps colour.
 */
export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-transparent bg-clip-padding font-extrabold whitespace-nowrap transition-[background-color,color,border-color,transform,opacity] duration-150 ease-(--ease-orbit) outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:not-aria-[haspopup]:scale-[0.97] motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-45 data-[loading=true]:disabled:opacity-70 data-[loading=true]:pointer-events-none data-[loading=true]:[&>svg:not([data-orbit-spinner])]:hidden aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        // The well colour: raised on the page, inset inside a card (cards set
        // --seg-track to the inset colour).
        secondary: "bg-(--seg-track,var(--raised)) text-foreground hover:bg-raised-hover aria-expanded:bg-raised-hover",
        inverse: "bg-foreground text-background hover:bg-foreground/85",
        outline:
          "border-border-strong bg-transparent text-foreground hover:bg-raised aria-expanded:bg-raised",
        ghost:
          "text-muted-foreground hover:bg-raised hover:text-foreground aria-expanded:bg-raised aria-expanded:text-foreground",
        destructive: "bg-tag-alert text-tag-alert-foreground hover:bg-tag-alert/80",
        link: "rounded-none px-0 text-primary-text underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-[18px] text-[0.9375rem]",
        sm: "h-9 px-3 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        cta: "h-14 px-8 font-display text-lg font-semibold [&_svg:not([class*='size-'])]:size-5",
        header: "h-[52px] px-7 font-display text-[1.0625rem] font-semibold",
        icon: "size-11",
        "icon-sm": "size-9 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-header": "size-[52px] [&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export type ButtonVariantProps = VariantProps<typeof buttonVariants>
