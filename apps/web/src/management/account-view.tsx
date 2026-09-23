import type { ReactNode } from "react";
import { Button } from "@winston/ui";

export function AccountView({
  children,
  onSignOut,
}: {
  children: ReactNode;
  onSignOut: () => void;
}) {
  return (
    <>
      <h1 className="text-xl font-medium">Account</h1>
      {children}
      <Button onClick={onSignOut}>Sign out</Button>
    </>
  );
}
