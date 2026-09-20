export const popupClasses = `z-50 max-h-[min(22rem,var(--available-height))]
  origin-(--transform-origin) overflow-auto rounded-lg bg-paper shadow-popup
  transition-[opacity,transform,translate,scale] duration-120 ease-in-out
  data-starting-style:-translate-y-0.5 data-starting-style:scale-99 data-starting-style:opacity-0
  data-ending-style:-translate-y-0.5 data-ending-style:scale-99 data-ending-style:opacity-0
  motion-reduce:transition-none`;

export const optionClasses = `flex min-h-9 items-center gap-2 rounded-sm px-3 py-2 text-sm
  outline-none data-highlighted:bg-hover data-disabled:opacity-40`;

export const selectorClasses = `flex w-full shrink-0 items-center justify-between gap-3
  rounded-md border border-line bg-paper px-2 text-sm whitespace-nowrap
  transition-[border-color,box-shadow,background-color] duration-120 ease-in-out
  enabled:hover:bg-hover disabled:opacity-45 motion-reduce:transition-none`;
