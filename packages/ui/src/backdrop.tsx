import { Dialog } from "@base-ui/react/dialog";

export function Backdrop() {
  return (
    <Dialog.Backdrop
      className="fixed inset-0 z-40 bg-black/20 transition-opacity duration-160 ease-in-out
        data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none"
    />
  );
}
